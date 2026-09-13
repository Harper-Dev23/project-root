// tools/headless/masks.mjs
//
// No clipping mask may be built from a Shape.
//
// A GeometryMask made from a Rectangle (or any Shape) draws NOTHING in Phaser's
// Canvas renderer: RectangleCanvasRenderer paints with fillRect, which adds no
// path, so the mask's ctx.clip() clips to an empty region. Every WebGL player
// sees such a list normally; a player whose browser withholds WebGL (LibreWolf by
// default) sees it completely blank. That shipped in four lists — Skills, the
// vendor inventory and both Stash columns — and was only found from a player
// report, because nobody testing in an ordinary browser can see it.
//
// This scans the source instead of rendering it: the failure only exists in a
// renderer the headless harness does not run, so a render test would pass
// regardless. See src/ui/masks.js for the working helper.
//
// Run: node tools/headless/masks.mjs

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHAPES = 'rectangle|ellipse|circle|triangle|polygon|star|arc|isobox|isotriangle|line|curve|grid';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Every place a mask is built from a Shape. Three spellings are covered:
 *   shapeVar.createGeometryMask()              where shapeVar = *.add.rectangle(...)
 *   *.add.rectangle(...)...createGeometryMask() chained in one statement
 *   new GeometryMask(scene, shapeVar)          where shapeVar is a Shape
 */
export function findShapeMasks(source) {
  const hits = [];
  const lineOf = (i) => source.slice(0, i).split('\n').length;

  // Names bound to a Shape: `x = this.add.rectangle(`, `this._y = scene.make.circle(`
  const shapeNames = new Set();
  const bind = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*=\\s*(?:this|scene|[A-Za-z_$][\\w$]*)\\.(?:add|make)\\.(?:${SHAPES})\\s*\\(`, 'g');
  for (const m of source.matchAll(bind)) shapeNames.add(m[1]);
  const bindNew = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*=\\s*new\\s+(?:Phaser\\.GameObjects\\.)?(?:Rectangle|Ellipse|Arc|Triangle|Polygon|Star|IsoBox|IsoTriangle|Line|Curve|Grid)\\s*\\(`, 'g');
  for (const m of source.matchAll(bindNew)) shapeNames.add(m[1]);

  for (const name of shapeNames) {
    const esc = name.replace(/[.$]/g, '\\$&');
    for (const m of source.matchAll(new RegExp(`${esc}\\s*\\.createGeometryMask\\s*\\(`, 'g'))) {
      hits.push({ line: lineOf(m.index), how: `${name}.createGeometryMask()` });
    }
    for (const m of source.matchAll(new RegExp(`GeometryMask\\s*\\(\\s*[^,]+,\\s*${esc}\\s*\\)`, 'g'))) {
      hits.push({ line: lineOf(m.index), how: `new GeometryMask(…, ${name})` });
    }
  }
  // Chained in one statement: this.add.rectangle(...).setX(...).createGeometryMask()
  const chained = new RegExp(`\\.(?:add|make)\\.(?:${SHAPES})\\s*\\([^;]*?\\)\\s*(?:\\.\\w+\\([^;]*?\\)\\s*)*\\.createGeometryMask\\s*\\(`, 'g');
  for (const m of source.matchAll(chained)) hits.push({ line: lineOf(m.index), how: 'chained Shape mask' });
  return hits;
}

console.log('=== the detector recognises every spelling it claims to ===');
{
  const cases = [
    ['a Rectangle assigned then masked', 'const s = this.add.rectangle(1,2,3,4,0,0);\nconst m = s.createGeometryMask();', 1],
    ['a property holding a Rectangle', 'this._maskShape = this.add.rectangle(0,0,1,1)\n  .setVisible(false);\nconst m = this._maskShape.createGeometryMask();', 1],
    ['a chained Rectangle mask', 'const m = this.add.rectangle(0,0,1,1).setVisible(false).createGeometryMask();', 1],
    ['an ellipse', 'const e = scene.add.ellipse(0,0,4,4);\nx.setMask(e.createGeometryMask());', 1],
    ['new GeometryMask on a Shape', 'const r = this.add.rectangle(0,0,1,1);\nconst m = new Phaser.Display.Masks.GeometryMask(this, r);', 1],
    ['a Graphics mask (the correct form)', 'const g = this.add.graphics();\ng.fillRect(0,0,1,1);\nconst m = g.createGeometryMask();', 0],
    ['the shared helper (the correct form)', 'const { graphics, mask } = createRectMask(this, 0, 0, 10, 10);', 0],
    ['a Rectangle used for something other than a mask', 'const bg = this.add.rectangle(0,0,1,1,0x222222);\nbg.setInteractive();', 0],
  ];
  for (const [label, src, want] of cases) {
    const got = findShapeMasks(src).length;
    check(`${label}: ${want ? 'flagged' : 'not flagged'}`, got === want, `${got} hit(s)`);
  }
}

console.log('=== the game source ===');
{
  // Optional folder argument, so the guard can be pointed at other source —
  // e.g. the pre-fix files, to prove it catches the bug it was written for.
  const scanRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');
  const files = jsFiles(scanRoot);
  const found = [];
  for (const f of files) {
    for (const h of findShapeMasks(readFileSync(f, 'utf8'))) {
      found.push(`${path.relative(ROOT, f)}:${h.line}  ${h.how}`);
    }
  }
  check(`no clipping mask is built from a Shape (${files.length} files scanned)`, found.length === 0,
    found.length ? '\n        ' + found.join('\n        ') : 'use createRectMask from src/ui/masks.js');
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
