"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DyadLinkPipelinePlayer = api;
    api.mount(root.document, root);
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  const abortError = () => Object.assign(new Error("Playback cancelled"), { name: "AbortError" });

  function waitFor(video, predicate, events, signal, timeoutMs) {
    if (signal.aborted) return Promise.reject(abortError());
    if (video.error) return Promise.reject(new Error("Video unavailable"));
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        events.forEach((name) => video.removeEventListener(name, check));
        video.removeEventListener("error", fail);
        signal.removeEventListener("abort", cancel);
      };
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const fail = () => { cleanup(); reject(new Error("Video unavailable")); };
      const cancel = () => { cleanup(); reject(abortError()); };
      events.forEach((name) => video.addEventListener(name, check));
      video.addEventListener("error", fail);
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error("Video loading timed out. Please try again.")); }, timeoutMs);
      check();
    });
  }

  class PairedVideoController {
    constructor(options = {}) {
      this.videos = [];
      this.hints = [];
      this.state = "idle";
      this.position = 0;
      this.rate = 1;
      this.loop = true;
      this.wantPlaying = false;
      this.epoch = 0;
      this.timeoutMs = options.timeoutMs || 15000;
      this.canPlay = options.canPlay || (() => true);
      this.onChange = options.onChange || (() => {});
      this.ensureLoaded = options.ensureLoaded || (() => {});
      this.setInterval = options.setInterval || ((callback, delay) => setInterval(callback, delay));
      this.clearInterval = options.clearInterval || ((timer) => clearInterval(timer));
      this.listeners = [];
      this.owners = new WeakMap();
      this.startedOwners = new WeakMap();
      this.timer = null;
      this.operation = null;
    }

    get duration() {
      const durations = this.videos.map((video, index) => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : this.hints[index]);
      return durations.length && durations.every((value) => Number.isFinite(value) && value > 0) ? Math.min(...durations) : 0;
    }

    snapshot() {
      return { state: this.state, position: this.position, duration: this.duration,
        rate: this.rate, loop: this.loop, wantPlaying: this.wantPlaying, count: this.videos.length };
    }

    emit(state = this.state, message = "") {
      this.state = state;
      this.onChange(this.snapshot(), message);
    }

    invalidate() {
      this.epoch += 1;
      this.operation?.abort();
      this.operation = null;
      if (this.timer !== null) this.clearInterval(this.timer);
      this.timer = null;
    }

    pauseVideos(videos = this.videos) { videos.forEach((video) => video.pause()); }

    pause() {
      this.position = this.currentPosition();
      this.wantPlaying = false;
      this.invalidate();
      this.pauseVideos();
      this.emit(this.videos.length ? "paused" : "idle");
    }

    currentPosition() {
      if (!this.videos.length) return 0;
      const time = Math.min(...this.videos.map((video) => Number.isFinite(video.currentTime) ? video.currentTime : 0));
      return Math.max(0, this.duration ? Math.min(time, this.duration) : time);
    }

    setVideos(videos, durationHints = []) {
      this.pause();
      this.listeners.forEach((remove) => remove());
      this.listeners = [];
      this.videos = [...videos];
      this.hints = durationHints;
      this.position = 0;
      this.videos.forEach((video) => {
        video.loop = false;
        video.playbackRate = this.rate;
        const listen = (name, handler) => {
          video.addEventListener(name, handler);
          this.listeners.push(() => video.removeEventListener(name, handler));
        };
        listen("loadedmetadata", () => this.emit());
        listen("durationchange", () => this.emit());
        listen("waiting", () => this.buffer());
        listen("stalled", () => this.buffer());
        listen("ended", () => { if (video.ended) this.finish(); });
        listen("error", () => {
          this.wantPlaying = false;
          this.invalidate();
          this.pauseVideos();
          this.emit("error", "A comparison video could not be loaded. Please reload the page.");
        });
      });
      this.emit(videos.length ? "paused" : "idle");
    }

    clear() { this.setVideos([]); }

    active(op) {
      return op.epoch === this.epoch && !op.signal.aborted && this.canPlay()
        && op.videos.every((video) => video.isConnected !== false);
    }

    async run(op, target, resume) {
      try {
        op.videos.forEach((video) => this.ensureLoaded(video));
        await Promise.all(op.videos.map((video) => waitFor(video,
          () => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0,
          ["loadedmetadata", "durationchange"], op.signal, this.timeoutMs)));
        if (!this.active(op)) throw abortError();
        target = Math.max(0, Math.min(target, this.duration));
        await Promise.all(op.videos.map(async (video) => {
          video.playbackRate = this.rate;
          if (Math.abs(video.currentTime - target) > 0.002) video.currentTime = target;
          await waitFor(video, () => !video.seeking && Math.abs(video.currentTime - target) < 0.04,
            ["seeked", "loadeddata", "canplay", "timeupdate"], op.signal, this.timeoutMs);
        }));
        if (!this.active(op)) throw abortError();
        this.position = target;
        if (!resume) { this.emit("paused"); return true; }
        await Promise.all(op.videos.map((video) => waitFor(video, () => video.readyState >= 3 && !video.seeking,
          ["canplay", "canplaythrough", "loadeddata", "seeked"], op.signal, this.timeoutMs)));
        if (!this.active(op)) throw abortError();
        const starts = op.videos.map((video) => {
          this.startedOwners.set(video, op);
          let result;
          try { result = video.play(); } catch (error) { result = Promise.reject(error); }
          return Promise.resolve(result).then(() => {
            // A late play() result must not restart a retired tab, nor pause a newer owner.
            const owner = this.owners.get(video);
            if (!this.active(op) && (owner === op || !this.wantPlaying || this.startedOwners.get(video) !== owner)) video.pause();
          });
        });
        await Promise.all(starts);
        if (!this.active(op)) throw abortError();
        this.emit("playing");
        this.timer = this.setInterval(() => this.tick(), 100);
        return true;
      } catch (error) {
        if (op.epoch !== this.epoch || error.name === "AbortError") {
          op.videos.forEach((video) => { if (this.owners.get(video) === op) video.pause(); });
          return false;
        }
        this.wantPlaying = false;
        this.invalidate();
        this.pauseVideos();
        this.emit("error", error.message || "Playback could not start. Please try again.");
        return false;
      }
    }

    resumeAt(target, resume = true, state = "loading") {
      if (this.videos.length !== 2 || !this.canPlay()) return Promise.resolve(false);
      this.invalidate();
      this.pauseVideos();
      this.wantPlaying = resume;
      this.operation = new AbortController();
      const op = { epoch: this.epoch, signal: this.operation.signal, videos: [...this.videos] };
      op.videos.forEach((video) => this.owners.set(video, op));
      this.emit(state);
      this.pending = this.run(op, target, resume);
      return this.pending;
    }

    play() {
      if (this.wantPlaying) return this.pending || Promise.resolve(true);
      const position = this.currentPosition();
      return this.resumeAt(this.duration && position >= this.duration - 0.025 ? 0 : position);
    }

    seek(time, resume = this.wantPlaying) { return this.resumeAt(time, resume, resume ? "loading" : "seeking"); }
    restart() { return this.resumeAt(0); }
    setRate(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error("Unsupported playback speed");
      this.rate = rate;
      this.videos.forEach((video) => { video.playbackRate = rate; });
      this.emit();
    }
    setLoop(value) { this.loop = Boolean(value); this.emit(); }

    buffer() {
      if (!this.wantPlaying || this.state !== "playing") return;
      void this.resumeAt(this.currentPosition(), true, "buffering");
    }

    finish() {
      if (!this.wantPlaying || this.state !== "playing") return;
      if (this.loop) { void this.resumeAt(0); return; }
      const end = this.duration;
      this.pause();
      this.videos.forEach((video) => { if (Math.abs(video.currentTime - end) > 0.002) video.currentTime = end; });
      this.position = end;
      this.emit("ended");
    }

    tick() {
      if (!this.wantPlaying || this.state !== "playing") return;
      if (!this.canPlay() || this.videos.some((video) => video.isConnected === false || video.paused)) { this.pause(); return; }
      if (this.duration && this.videos.some((video) => video.currentTime >= this.duration - 0.025)) { this.finish(); return; }
      const [a, b] = this.videos;
      if (Math.abs(a.currentTime - b.currentTime) > 0.08) {
        void this.resumeAt(Math.min(a.currentTime, this.duration));
        return;
      }
      this.position = this.currentPosition();
      this.emit();
    }
  }

  function mount(document, window) {
    const section = document?.getElementById("pipeline-comparison");
    if (!section || section.pipelineController) return;
    const clips = window.DYADLINK_PIPELINE_COMPARISON?.clips || [];
    const byId = (id) => document.getElementById(id);
    const tabs = byId("pipeline-tabs");
    const panel = byId("pipeline-panel");
    const pair = byId("pipeline-pair");
    const play = byId("pipeline-play");
    const restart = byId("pipeline-restart");
    const speed = byId("pipeline-speed");
    const loop = byId("pipeline-loop");
    const seek = byId("pipeline-seek");
    const timeline = byId("pipeline-time");
    const status = byId("pipeline-status");
    const title = byId("pipeline-action-title");
    const textNode = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const formatTime = (seconds) => `${Math.floor(Math.max(0, seconds) / 60)}:${(Math.max(0, seconds) % 60).toFixed(2).padStart(5, "0")}`;
    let selected;
    let dragging = false;
    let previousState = "";
    const controller = new PairedVideoController({
      canPlay: () => !document.hidden,
      ensureLoaded: (video) => {
        if (!video.getAttribute("src")) {
          video.src = video.dataset.src;
          video.preload = "auto";
          video.load();
        }
      },
      onChange: (state, message) => {
        const present = state.count === 2;
        play.disabled = !present;
        restart.disabled = !present;
        speed.disabled = !present;
        seek.disabled = !present || !state.duration;
        loop.disabled = !present;
        play.querySelector("span").textContent = state.wantPlaying ? "Pause both" : "Play both";
        play.setAttribute("aria-pressed", String(state.wantPlaying));
        play.setAttribute("aria-label", state.wantPlaying ? "Pause both comparison videos" : "Play both comparison videos");
        panel.setAttribute("aria-busy", String(["loading", "seeking", "buffering"].includes(state.state)));
        if (!dragging) {
          seek.value = String(state.duration ? Math.round(1000 * state.position / state.duration) : 0);
          timeline.textContent = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
        }
        seek.setAttribute("aria-valuetext", `${formatTime(state.position)} of ${formatTime(state.duration)}`);
        if (message) status.textContent = message;
        else if (state.state !== previousState) {
          status.textContent = state.state === "loading" ? "Loading both videos…"
            : state.state === "buffering" ? "Buffering both videos…"
              : state.state === "seeking" ? "Seeking both videos…"
                : state.state === "playing" ? "Playing both videos in sync."
                  : state.state === "ended" ? "Both videos finished."
                    : "Ready. Play both videos together.";
        }
        previousState = state.state;
      },
    });
    section.pipelineController = controller;
    const buttons = [];

    function render(clip) {
      if (selected === clip) return;
      dragging = false;
      controller.clear();
      pair.querySelectorAll("video").forEach((video) => {
        video.pause();
        video.removeAttribute("src");
        video.removeAttribute("poster");
        delete video.dataset.src;
        video.load();
      });
      pair.replaceChildren();
      selected = clip;
      section.dataset.currentAction = clip.action;
      section.dataset.currentClipId = clip.id;
      title.textContent = clip.title;
      const buttonId = "pipeline-tab-" + clip.action;
      panel.setAttribute("aria-labelledby", buttonId);
      buttons.forEach((button) => {
        const active = button.dataset.action === clip.action;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
      });
      const videos = [];
      for (const [key, label, method] of [["ours", "Ours", "DyadLink"], ["others", "Others", "InterAgent + OmniRetarget + BeyondMimic"]]) {
        const item = clip[key];
        const row = textNode("article", "pipeline-row");
        row.dataset.method = key;
        const heading = textNode("div", "pipeline-row-heading");
        heading.append(textNode("h3", "", label), textNode("p", "pipeline-method", method));
        const frame = textNode("div", "pipeline-frame");
        const video = textNode("video");
        video.dataset.src = item.src;
        video.preload = "none";
        video.controls = false;
        video.playsInline = true;
        video.muted = true;
        video.defaultMuted = true;
        video.loop = false;
        video.poster = item.poster;
        video.setAttribute("aria-label", `${label}: ${clip.title}. Use the shared playback controls.`);
        frame.append(video);
        row.append(heading, frame);
        pair.append(row);
        videos.push(video);
      }
      controller.setVideos(videos, [clip.ours.duration, clip.others.duration]);
      controller.setRate(Number(speed.value));
      controller.setLoop(loop.checked);
    }

    clips.forEach((clip, index) => {
      const button = textNode("button", "pipeline-tab", clip.title);
      button.type = "button";
      button.id = "pipeline-tab-" + clip.action;
      button.dataset.action = clip.action;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "pipeline-panel");
      button.setAttribute("aria-selected", "false");
      button.tabIndex = -1;
      button.addEventListener("click", () => render(clip));
      button.addEventListener("keydown", (event) => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!offset && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const target = event.key === "Home" ? 0 : event.key === "End" ? clips.length-1 : (index+offset+clips.length)%clips.length;
        render(clips[target]);
        buttons[target].focus();
      });
      buttons.push(button);
      tabs.append(button);
    });
    play.addEventListener("click", () => { if (controller.wantPlaying) controller.pause(); else void controller.play(); });
    restart.addEventListener("click", () => { void controller.restart(); });
    speed.addEventListener("change", () => controller.setRate(Number(speed.value)));
    loop.addEventListener("change", () => controller.setLoop(loop.checked));
    seek.addEventListener("input", () => {
      dragging = true;
      const target = Number(seek.value)/1000*controller.duration;
      timeline.textContent = `${formatTime(target)} / ${formatTime(controller.duration)}`;
    });
    seek.addEventListener("change", () => { dragging = false; void controller.seek(Number(seek.value)/1000*controller.duration); });
    document.addEventListener("dyadlink:pause-all", () => controller.pause());
    document.addEventListener("visibilitychange", () => { if (document.hidden) controller.pause(); });
    window.addEventListener("pagehide", () => controller.pause());
    window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", (event) => { if (event.matches) controller.pause(); });
    // Observe the whole section, not each row: on small screens one row can be offscreen.
    if ("IntersectionObserver" in window) new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) controller.pause();
    }, { threshold: 0 }).observe(section);
    if (clips.length) render(clips[0]);
    else { controller.emit("idle", "Comparison videos are not available yet."); }
    window.DYADLINK_PIPELINE_READY = true;
  }

  return { PairedVideoController, mount };
});
