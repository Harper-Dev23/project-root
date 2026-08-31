#!/usr/bin/env python3
"""Build grouped patch notes for a Pages deploy and post them to Discord.

Run from a GitHub Actions `deployment_status` job. Reads everything it needs
from the environment:

    DISCORD_WEBHOOK   the Discord webhook URL (required; absent = skip quietly)
    GITHUB_REPOSITORY owner/repo
    GITHUB_TOKEN      to look up the previously deployed commit
    GITHUB_SHA        the commit just deployed
    PAGE_URL          the live site URL
    ENVIRONMENT       deployment environment name (github-pages)

Collects EVERY commit since the previous successful deploy, not just the last
one, and groups them by an optional `prefix:` on the subject line:

    balance: soften lacerate slope
    fix:     turn order skipped a unit on mid-turn death
    content: bone weapons drop from the bone pile
    ui:      wrap the bonepile drop log
    docs:    update weakness scaling entry

The prefix is optional. Unprefixed commits land under "Changes", so this works
from day one and gets tidier as the convention is adopted.

Never fails the build: any error here prints and exits 0. A missed Discord
message is not worth a red deploy.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

API = 'https://api.github.com'
FIELD_CAP = 1000        # Discord's per-field limit is 1024
# Per-BULLET cap. Was 160, which cut most real notes mid-sentence and left a
# trailing '...' -- a 313-character bugfix note lost exactly the part naming
# the symptoms. Discord's real constraint is the 1024-char FIELD, so this only
# needs to stop one runaway bullet from eating a whole field on its own.
SUBJECT_CAP = 400
MAX_FIELDS = 24         # Discord allows 25 fields; keep one spare for 'Play'
EMBED_CAP = 5500        # Discord's total embed budget is 6000
NL = chr(10)            # newline, spelled this way so an edit can't mangle it

GROUPS = [
    ('balance', 'Balance'),
    ('fix', 'Fixes'),
    ('content', 'New & Content'),
    ('feat', 'New & Content'),
    ('ui', 'Interface'),
    ('docs', 'Journal & Docs'),
]


def sh(*args):
    """Run a command, return stdout, or '' on any failure."""
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              check=False).stdout.strip()
    except Exception:
        return ''


def get_json(url, token):
    req = urllib.request.Request(url, headers={
        'Authorization': 'Bearer %s' % token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'behelith-patch-notes',
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def previous_deployed_sha(repo, env, token, current):
    """Newest deployment of `env` whose sha isn't the one we just shipped."""
    if not token:
        return ''
    try:
        url = '%s/repos/%s/deployments?environment=%s&per_page=30' % (API, repo, env)
        for d in get_json(url, token):
            sha = d.get('sha') or ''
            if sha and sha != current:
                return sha
    except Exception as e:
        print('could not read previous deployments (%s)' % e)
    return ''


def extract(raw):
    """Turn raw `git log %B` output into individual patch-note lines.

    Each commit contributes its subject, PLUS any bulleted lines from its body.
    That lets one commit carry a whole batch of notes:

        balance: DOT and decay pass

        - fire: no longer double-dips meter loss
        - lacerate: slope softened 0.0025 -> 0.002

    ...which reads as three grouped bullets instead of one. Non-bulleted body
    prose is ignored, so longer rationale in a commit message stays out of the
    player-facing notes.
    """
    lines = []
    drop = re.compile(r'^(Co-authored-by|Signed-off-by|Change-Id)\s*:', re.I)
    for msg in raw.split(chr(0)):
        parts = [l.rstrip() for l in msg.strip().splitlines()]
        parts = [l for l in parts if l.strip() and not drop.match(l.strip())]
        if not parts:
            continue
        subject = parts[0].strip()
        # A commit's own prefix carries down to its bullets, so a batch of
        # balance notes under `balance: ...` all land in Balance rather than
        # falling through to the generic bucket.
        m = re.match(r'^\s*([a-zA-Z]+)\s*:\s*(.+)$', subject)
        prefix = m.group(1).lower() + ': ' if m and m.group(1).lower() in dict(GROUPS) else ''

        bullets = []
        for l in parts[1:]:
            bm = re.match(r'^\s*[-*]\s+(.+)$', l)
            if bm:
                item = bm.group(1).strip()
                # a bullet may carry its own prefix; respect it if so
                own = re.match(r'^\s*([a-zA-Z]+)\s*:\s*(.+)$', item)
                if own and own.group(1).lower() in dict(GROUPS):
                    bullets.append(item)
                else:
                    bullets.append(prefix + item)

        # Bullets REPLACE the subject when present - the subject is then a
        # heading for the batch, and repeating it would just be noise.
        lines.extend(bullets if bullets else [subject])
    return lines


def clip(text, cap):
    """Trim to `cap` chars on a WORD boundary so a cut note doesn't end
    mid-word. Returns the text untouched when it already fits."""
    if len(text) <= cap:
        return text
    cut = text[:cap]
    sp = cut.rfind(' ')
    if sp > cap * 0.6:
        cut = cut[:sp]
    return cut.rstrip(' ,;:-') + '...'


def group(subjects):
    label_for = dict(GROUPS)
    order, seen = [], set()
    for _, lbl in GROUPS:
        if lbl not in seen:
            order.append(lbl)
            seen.add(lbl)
    order.append('Changes')

    buckets = {lbl: [] for lbl in order}
    for s in subjects:
        m = re.match(r'^\s*([a-zA-Z]+)\s*:\s*(.+)$', s)
        if m and m.group(1).lower() in label_for:
            buckets[label_for[m.group(1).lower()]].append(m.group(2).strip())
        else:
            buckets['Changes'].append(s)
    return order, buckets


def main():
    webhook = os.environ.get('DISCORD_WEBHOOK', '')
    if not webhook:
        print('DISCORD_WEBHOOK not set - skipping (not a failure).')
        return

    repo = os.environ.get('GITHUB_REPOSITORY', '')
    sha = os.environ.get('GITHUB_SHA', '')
    token = os.environ.get('GITHUB_TOKEN', '')
    env = os.environ.get('ENVIRONMENT', 'github-pages')
    url = os.environ.get('PAGE_URL') or 'https://%s.github.io/%s/' % tuple(
        (repo.split('/') + ['', ''])[:2]) if repo else ''

    prev = previous_deployed_sha(repo, env, token, sha)
    if prev and sh('git', 'cat-file', '-e', prev + '^{commit}') == '':
        # cat-file prints nothing on success; confirm the object really resolves
        exists = subprocess.run(['git', 'cat-file', '-e', prev + '^{commit}'],
                                capture_output=True).returncode == 0
        if not exists:
            prev = ''

    if prev:
        out = sh('git', 'log', '--no-merges', '--pretty=%B%x00', '%s..%s' % (prev, sha))
        print('diffing %s..%s' % (prev[:7], sha[:7]))
    else:
        out = sh('git', 'log', '--no-merges', '--pretty=%B%x00', '-1', sha)
        print('no previous deployment found - using the latest commit only')

    n_commits = len([m for m in out.split(chr(0)) if m.strip()]) or 1
    subjects = extract(out) or ['new build']
    print('commits: %d   patch-note lines: %d' % (n_commits, len(subjects)))

    order, buckets = group(subjects)
    fields = []
    spent = 0
    for lbl in order:
        items = buckets[lbl]
        if not items:
            continue
        # A category too big for one field CONTINUES into another rather than
        # dropping its tail with "...and N more". The notes are the whole point
        # of the message; silently discarding half of them defeats it.
        chunks, buf, total = [], [], 0
        for it in items:
            line = '- ' + clip(it, SUBJECT_CAP)
            if buf and total + len(line) + 1 > FIELD_CAP:
                chunks.append(buf)
                buf, total = [], 0
            buf.append(line)
            total += len(line) + 1
        if buf:
            chunks.append(buf)
        for n, chunk in enumerate(chunks):
            value = NL.join(chunk)
            if len(fields) >= MAX_FIELDS or spent + len(value) > EMBED_CAP:
                fields.append({'name': lbl,
                               'value': '- (more changes than fit here - see the compare link)'})
                spent = EMBED_CAP
                break
            fields.append({'name': lbl if n == 0 else '%s (cont.)' % lbl,
                           'value': value})
            spent += len(value)

    fields.append({'name': 'Play', 'value': url})

    compare = 'https://github.com/%s/compare/%s...%s' % (repo, prev or sha, sha)
    plural = 'commit' if n_commits == 1 else 'commits'
    payload = {
        'username': "Behel'ith",
        'embeds': [{
            'title': 'New build is live',
            'description': '%d %s - [`%s`](https://github.com/%s/commit/%s) - [compare](%s)'
                           % (n_commits, plural, sha[:7], repo, sha, compare),
            'url': url,
            'color': 13795140,
            'fields': fields[:25],
            'footer': {'text': 'Reload the page to get it. Your save is kept.'},
        }],
    }

    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(webhook, data=body, headers={
        'Content-Type': 'application/json',
        'User-Agent': 'behelith-patch-notes',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print('posted to Discord (%s)' % r.status)
    except Exception as e:
        print('Discord post failed, build unaffected: %s' % e)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:                      # never fail the deploy
        print('patch-notes error (ignored): %s' % e)
    sys.exit(0)
