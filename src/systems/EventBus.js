export default class EventBus {
  constructor(){ this._map = new Map(); }
  on(event, handler){
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(handler);
    return () => this._map.get(event)?.delete(handler);
  }
  emit(event, payload){
    const subs = this._map.get(event);
    if (!subs) return;
    for (const fn of [...subs]) fn(payload);
  }
}
