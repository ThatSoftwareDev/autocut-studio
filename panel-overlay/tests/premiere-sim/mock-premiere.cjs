// Stark vereinfachtes Premiere-Objektmodell, nur um die Schnitt-Logik zu testen.
const TPS = 254016000000;
let nextId = 1;

class Time {
  constructor() { this._t = 0; }
  get ticks() { return String(this._t); }
  set ticks(v) { this._t = Number(v); }
  get seconds() { return this._t / TPS; }
  set seconds(v) { this._t = Math.round(v * TPS); }
  getFormatted() { return "TC:" + this._t; }
}
const T = (ticks) => { const t = new Time(); t.ticks = ticks; return t; };

function collection(arr) {
  const c = { numItems: arr.length, numTracks: arr.length, numSequences: arr.length };
  arr.forEach((x, i) => (c[i] = x));
  return c;
}

const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

class Param {
  constructor(item, value) { this.item = item; this.value = value; this.tv = false; this.keys = new Map(); }
  get sim() { return this.item.track.seq.sim; }
  getValue() { return this.value; }
  setValue(v) { this.value = v; return 0; }
  isTimeVarying() { return this.tv; }
  setTimeVarying(on) {
    this.tv = on;
    if (on && this.sim.autoKey) this.keys.set(this.item._in + 7, { v: this.value, interp: 0 });
    return 0;
  }
  _check(t) {
    if (!(t instanceof Time)) throw new Error("Keyframe-Zeit muss Time sein");
    const lo = this.item._in, hi = this.item._in + (this.item._e - this.item._s);
    if (t._t < lo || t._t > hi) this.sim.keyOutOfRange++;
  }
  addKey(t) { this._check(t); if (!this.keys.has(t._t)) this.keys.set(t._t, { v: this.getValueAtTime(t), interp: 0 }); return 0; }
  setValueAtKey(t, v) { this._check(t); this.keys.get(t._t).v = v; return 0; }
  setInterpolationTypeAtKey(t, mode) { this.keys.get(t._t).interp = mode; return 0; }
  removeKey(t) { this.keys.delete(t._t); return 0; }
  getKeys() { return this.keys.size ? [...this.keys.keys()].sort((a, b) => a - b).map(T) : 0; }
  getValueAtTime(t) {
    if (!this.tv || !this.keys.size) return this.value;
    const ks = [...this.keys.entries()].sort((a, b) => a[0] - b[0]);
    if (t._t <= ks[0][0]) return ks[0][1].v;
    if (t._t >= ks[ks.length - 1][0]) return ks[ks.length - 1][1].v;
    for (let i = 0; i + 1 < ks.length; i++) {
      const [ta, a] = ks[i], [tb, b] = ks[i + 1];
      if (t._t >= ta && t._t <= tb) {
        let x = (t._t - ta) / (tb - ta);
        if (a.interp === 5 && this.sim.bezierEases) x = easeInOutCubic(x);
        if (a.interp === 4) x = 0;
        return a.v + (b.v - a.v) * x;
      }
    }
    return this.value;
  }
}

class Item {
  constructor(track, start, end, inPoint, group, opts = {}) {
    this.track = track; this.nodeId = "n" + nextId++; this.name = opts.name || "clip";
    this._s = start; this._e = end; this._in = inPoint; this.group = group;
    this.mediaType = track.kind === "V" ? "Video" : "Audio";
    this.disabled = false; this.projectItem = opts.projectItem || { getMediaPath: () => opts.path || "C:/media/take.mp4" };
    this.selected = false;
    this.motion = { scale: new Param(this, opts.scale || 100), uniform: { getValue: () => true } };
  }
  get components() {
    const motion = { matchName: "AE.ADBE Motion", properties: collection([new Param(this, 0), this.motion.scale, new Param(this, 100), this.motion.uniform]) };
    return collection([{ matchName: "AE.ADBE Opacity", properties: collection([]) }, motion]);
  }
  setSelected(on) { this.selected = !!on; return 0; }
  get start() { return T(this._s); }
  get end() { return T(this._e); }
  set end(t) { this._e = t._t; }
  get inPoint() { return T(this._in); }
  getSpeed() { return 1; }
  isSpeedReversed() { return 0; }
  linked() {
    if (this.group == null) return [];
    return this.track.seq.allItems().filter(
      (o) => o !== this && o.group === this.group && o.track.kind !== this.track.kind && o._s < this._e && o._e > this._s
    );
  }
  getLinkedItems() { return collection(this.linked()); }
  remove() {
    const victims = [this, ...this.linked()];
    victims.forEach((v) => { v.track.items = v.track.items.filter((x) => x !== v); v.dead = true; });
    return 0;
  }
  move(arg) {
    if (this.dead) throw new Error("dead");
    const sim = this.track.seq.sim;
    let delta;
    if (arg instanceof Time) { if (!sim.acceptTime) return 1; delta = arg._t; }
    else delta = Math.round(arg * TPS + (sim.secondsJitter || 0));
    const movers = sim.moveLinked ? [this, ...this.linked()] : [this];
    movers.forEach((m) => {
      const ns = m._s + delta, ne = m._e + delta;
      // Überschreiben simulieren: überlappende Nachbarn werden gekürzt
      m.track.items.forEach((o) => {
        if (o === m || movers.includes(o)) return;
        if (o._s < ne && o._e > ns) sim.overwrites++;
      });
      m._s = ns; m._e = ne;
    });
    movers.forEach((m) => m.track.sort());
    return 0;
  }
}

class Track {
  constructor(seq, kind) { this.seq = seq; this.kind = kind; this.items = []; this.locked = false; }
  get clips() { return collection(this.items); }
  get transitions() { return collection([]); }
  isLocked() { return this.locked; }
  isMuted() { return false; }
  sort() { this.items.sort((a, b) => a._s - b._s); }
  add(start, end, inPoint, group, opts) { const it = new Item(this, start, end, inPoint, group, opts); this.items.push(it); this.sort(); return it; }
  _parse(arg, accepts) {
    const kind = arg instanceof Time ? "time" : typeof arg === "string" ? "ticks" : "seconds";
    if (kind === accepts) return kind === "time" ? arg._t : kind === "ticks" ? Number(arg) : Math.round(arg * TPS);
    if (kind === "time") throw new Error("Time nicht unterstützt");
    return kind === "ticks" ? Number(arg) * TPS : Math.round(arg); // falsch interpretiert
  }
  _clear(start, end) {
    this.items = this.items.filter((o) => {
      if (o._s < end && o._e > start) { this.seq.sim.overwrites++; o.dead = true; return false; }
      return true;
    });
  }
  overwriteClip(pi, arg) {
    const sim = this.seq.sim;
    const start = this._parse(arg, sim.overwriteAccepts || "ticks");
    const inP = pi._in == null ? 0 : pi._in;
    const outP = pi._out == null ? pi.dur : pi._out;
    const end = start + (outP - inP);
    const group = "g" + nextId++;
    this._clear(start, end);
    const it = new Item(this, start, end, inP, this.kind === "V" && pi.hasAudio ? group : null, { projectItem: pi, name: pi.name });
    this.items.push(it); this.sort();
    if (this.kind === "V" && pi.hasAudio) {
      const idx = this.seq.v.indexOf(this);
      const at = this.seq.a[idx];
      if (at) { at._clear(start, end); at.items.push(new Item(at, start, end, inP, group, { projectItem: pi, name: pi.name })); at.sort(); }
    }
    return true;
  }
  razor(tc) {
    if (this.locked) return;
    const t = Number(String(tc).replace("TC:", ""));
    const it = this.items.find((x) => x._s < t && x._e > t);
    if (!it) return;
    const right = new Item(this, t, it._e, it._in + (t - it._s), it.group, { name: it.name });
    it._e = t;
    this.items.push(right); this.sort();
  }
}

class Seq {
  constructor(sim, name, tpf, nV, nA) {
    this.sim = sim; this.name = name; this.sequenceID = "seq" + nextId++; this.timebase = String(tpf);
    this.v = Array.from({ length: nV }, () => new Track(this, "V"));
    this.a = Array.from({ length: nA }, () => new Track(this, "A"));
  }
  get videoTracks() { return collection(this.v); }
  get audioTracks() { return collection(this.a); }
  allItems() { return [...this.v, ...this.a].flatMap((t) => t.items); }
  get end() { return String(Math.max(0, ...this.allItems().map((i) => i._e))); }
  getSettings() { return { videoFrameRate: T(this.timebase), videoDisplayFormat: 101, videoFrameWidth: 1920, videoFrameHeight: 1080 }; }
  getSelection() { return this.allItems().filter((i) => i.selected); }
  unlinkSelection() { this.getSelection().forEach((i) => (i.group = "u" + nextId++)); return true; }
  setPlayerPosition(t) { this.player = t; }
  clone() {
    const c = new Seq(this.sim, this.name + " Copy", Number(this.timebase), this.v.length, this.a.length);
    const groupMap = {};
    [[this.v, c.v], [this.a, c.a]].forEach(([src, dst]) =>
      src.forEach((tr, i) => tr.items.forEach((it) => {
        if (it.group != null && !(it.group in groupMap)) groupMap[it.group] = "g" + nextId++;
        dst[i].add(it._s, it._e, it._in, it.group == null ? null : groupMap[it.group], { name: it.name });
        dst[i].locked = tr.locked;
      })));
    this.sim.sequences.push(c);
    return c;
  }
}

class ProjectItem {
  constructor(sim, path, media) {
    this.sim = sim; this.type = 1; this.path = path; this.name = path.split("/").pop();
    this.dur = media.dur; this.hasAudio = media.hasAudio; this._in = null; this._out = null;
  }
  getMediaPath() { return this.path; }
  _p(arg) { return Track.prototype._parse.call(null, arg, this.sim.inPointAccepts || "ticks"); }
  setInPoint(arg) { this._in = this._p(arg); return 0; }
  setOutPoint(arg) { this._out = this._p(arg); return 0; }
  getInPoint() { return T(this._in == null ? 0 : this._in); }
  getOutPoint() { return T(this._out == null ? this.dur : this._out); }
  clearInPoint() { this._in = null; return true; }
  clearOutPoint() { this._out = null; return true; }
}

class Bin {
  constructor(name) { this.type = 2; this.name = name; this.list = []; }
  get children() { return collection(this.list); }
  createBin(name) { const b = new Bin(name); this.list.push(b); return b; }
}

function install(sim) {
  sim.sequences = [];
  sim.overwrites = 0;
  sim.keyOutOfRange = 0;
  sim.media = sim.media || {};
  const root = new Bin("root");
  const project = {
    rootItem: root,
    importFiles(paths, suppress, bin) {
      paths.forEach((p) => { if (sim.media[p]) bin.list.push(new ProjectItem(sim, p, sim.media[p])); });
      return true;
    },
    get sequences() { return collection(sim.sequences); },
    activeSequence: null,
    openSequence(id) { project.activeSequence = sim.sequences.find((s) => s.sequenceID === id) || project.activeSequence; return true; },
  };
  global.app = { project, enableQE() {} };
  global.qe = {
    project: {
      getActiveSequence() {
        const s = project.activeSequence;
        if (!s) return null;
        return { name: s.name, getVideoTrackAt: (i) => s.v[i], getAudioTrackAt: (i) => s.a[i] };
      },
    },
  };
  global.Time = Time;
  return project;
}

module.exports = { install, Seq, TPS, Time };
