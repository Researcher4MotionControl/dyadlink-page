"use strict";

(() => {
  const config = window.DYADLINK_CONFIG || {};
  const media = window.DYADLINK_MEDIA || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icons = () => window.lucide?.createIcons();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const icon = (name) => {
    const element = node("i");
    element.dataset.lucide = name;
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  const categoryOf = (clip) => clip.category || (clip.dataset === "CoDance" ? "Dance" : "Interact");
  const available = (clips) => (clips || []).filter((clip) => !!clip.src);
  const pairKeys = ["G1toG1", "G1toT1"];
  const retargetClips = (media.retargeting || []).filter((clip) => pairKeys.some((key) => clip[key]?.src));
  const stageData = {
    generation: available(media.generation),
    control: available(media.control),
    "sim-to-real": available(media.hardware),
  };
  const stageLabels = { generation: "Generation", retargeting: "Retargeting", control: "Control", "sim-to-real": "Sim-to-Real" };
  const videoEvents = new WeakMap();
  let noticeTimer;
  let pairPlaying = false;
  let pairTimer;
  let pairEpoch = 0;
  let selectedRetargets = [];
  let dialogTrigger;
  let dialogEvents;

  function notify(message) {
    clearTimeout(noticeTimer);
    $("#notice").textContent = message;
    $("#notice").classList.add("visible");
    noticeTimer = setTimeout(() => $("#notice").classList.remove("visible"), 3500);
  }
  function loadVideo(video) {
    if (video.dataset.disposed) return;
    if (!video.getAttribute("src") && video.dataset.src) {
      video.src = video.dataset.src;
      video.preload = "metadata";
      video.load();
    }
  }
  async function safePlay(video, quiet = false) {
    if (!video.isConnected || video.dataset.disposed) return false;
    loadVideo(video);
    try {
      await video.play();
      if (!video.isConnected || video.dataset.disposed || document.hidden) {
        video.pause();
        return false;
      }
      return true;
    } catch (error) {
      if (!quiet && error.name !== "AbortError" && video.isConnected && !video.dataset.disposed) {
        notify("Use the video's play button to start playback.");
      }
      return false;
    }
  }
  function pauseAll() {
    stopPair();
    $$("video").forEach((video) => video.pause());
  }
  const lazyObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      loadVideo(target);
      lazyObserver.unobserve(target);
    });
  }, { rootMargin: "180px 0px" }) : null;
  const visibilityObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting && !target.paused) {
        if (target.closest("#retarget-pair") && pairPlaying) stopPair();
        else target.pause();
      }
      // Autoplay is opt-in for the hero only; all gallery videos start paused.
      if (isIntersecting && target.dataset.autoplay === "true" && !target.dataset.autoStarted
          && !reducedMotion.matches && !navigator.connection?.saveData) {
        target.dataset.autoStarted = "true";
        safePlay(target, true);
      }
    });
  }, { threshold: 0.02 }) : null;

  function makeFrame(clip, options = {}) {
    const frame = node("div", "video-frame");
    const video = node("video");
    video.controls = true;
    video.playsInline = true;
    video.loop = clip.loop ?? true;
    video.muted = clip.muted ?? true;
    video.defaultMuted = video.muted;
    video.preload = "none";
    video.dataset.src = clip.src;
    video.dataset.autoplay = String(!!options.autoplay);
    video.setAttribute("aria-label", clip.title || "Interaction video");
    if (options.videoId) video.id = options.videoId;
    if (clip.poster) video.poster = clip.poster;
    const expand = node("button", "icon-button expand-video");
    expand.type = "button";
    expand.setAttribute("aria-label", "Expand " + (clip.title || "video"));
    expand.title = "Expand video";
    expand.append(icon("maximize-2"));
    const controller = new AbortController();
    videoEvents.set(video, controller);
    const events = { signal: controller.signal };
    expand.addEventListener("click", () => openDialog(clip, video, expand), events);
    const status = node("div", "video-status");
    status.hidden = true;
    status.setAttribute("role", "status");
    video.addEventListener("error", () => {
      status.replaceChildren(node("strong", "", "Video unavailable"), node("span", "", "Please reload this page to try again."));
      status.hidden = false;
      expand.hidden = true;
      video.controls = false;
    }, events);
    video.addEventListener("play", () => {
      if (document.hidden || video.dataset.disposed) video.pause();
      updatePlayButtons();
    }, events);
    video.addEventListener("pause", updatePlayButtons, events);
    frame.append(video, expand, status);
    if (lazyObserver) lazyObserver.observe(video);
    else loadVideo(video);
    visibilityObserver?.observe(video);
    return frame;
  }
  function makeCard(clip, index = 0, options = {}) {
    const card = node("article", "video-card");
    card.dataset.clipId = clip.id || String(index);
    card.append(makeFrame(clip, options));
    const caption = node("div", "video-caption");
    const text = node("div");
    text.append(node("h3", "", clip.title || "Sequence " + (index + 1)));
    const meta = [clip.dataset, clip.sample ? "#" + clip.sample : "", options.pair ? "Robot pair" : ""].filter(Boolean).join(" · ");
    if (meta) text.append(node("p", "", meta));
    caption.append(text);
    const download = node("a", "clip-download");
    download.href = clip.src;
    download.download = clip.src.split("/").pop();
    download.title = "Download video";
    download.setAttribute("aria-label", "Download " + clip.title);
    download.append(icon("download"));
    caption.append(download);
    card.append(caption);
    const condition = clip.condition || (options.generation ? clip.description : "");
    if (options.generation && condition) {
      const details = node("details", "condition");
      const label = clip.promptLabel || (clip.sourceKind === "synthetic_dataset_motion_variant" ? "Source annotation" : "Text condition");
      details.append(node("summary", "", label), node("p", "", condition));
      card.append(details);
    }
    return card;
  }
  function clearMedia(container) {
    $$("video", container).forEach((video) => {
      video.dataset.disposed = "true";
      videoEvents.get(video)?.abort();
      videoEvents.delete(video);
      lazyObserver?.unobserve(video);
      visibilityObserver?.unobserve(video);
      video.pause();
      video.removeAttribute("src");
      video.removeAttribute("poster");
      delete video.dataset.src;
      video.load();
    });
    container.replaceChildren();
  }
  function prepareCategories(stage) {
    const clips = stage === "retargeting" ? retargetClips : stageData[stage];
    $$("[data-category]", $("#" + stage)).forEach((button) => {
      const count = clips.filter((clip) => categoryOf(clip) === button.dataset.category).length;
      button.hidden = count === 0;
      button.disabled = count === 0;
      button.replaceChildren(document.createTextNode(button.dataset.category + " "), node("span", "tab-count", String(count)));
      button.setAttribute("aria-label", button.dataset.category + ": " + count + (stage === "retargeting" ? " sequences" : " videos"));
    });
  }
  function setCategoryState(stage, category) {
    const section = $("#" + stage);
    section.dataset.currentCategory = category;
    $$("[data-category]", section).forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.category === category)));
  }
  function renderGallery(stage, category) {
    const gallery = $("#" + stage + "-gallery");
    clearMedia(gallery);
    const clips = category ? stageData[stage].filter((clip) => categoryOf(clip) === category) : stageData[stage];
    if (category) setCategoryState(stage, category);
    clips.forEach((clip, index) => gallery.append(makeCard(clip, index, { generation: stage === "generation" })));
    if (!clips.length) gallery.append(node("p", "empty-gallery", "No videos in this category."));
    $("#" + stage + "-count").textContent = clips.length + (clips.length === 1 ? " video" : " videos");
    const datasets = [...new Set(clips.map((clip) => clip.dataset).filter(Boolean))].join(" / ");
    $("#" + stage + "-context").textContent = stage === "generation"
      ? datasets + " · Expand a clip's text description for details."
      : stage === "control" ? datasets + " · Learned-policy execution in physics simulation"
        : "Real-world recordings · InterHuman motion references";
    if (stage === "generation") {
      const kinds = new Set(clips.map((clip) => clip.sourceKind));
      const notes = [];
      if (kinds.has("model_prediction")) notes.push("Model output: a generated follower paired with its leader.");
      if (kinds.has("synthetic_dataset_motion_variant")) notes.push("Procedural synthesis: motion variants constructed from dataset sequences, not model predictions.");
      if (kinds.has("gt_assisted_hybrid")) notes.push("GT-assisted hybrid: examples combining ground-truth motion and model output.");
      $("#generation-details").hidden = notes.length === 0;
      $("#generation-provenance").textContent = notes.join(" ");
    }
    updatePlayButtons();
    icons();
  }

  function pairVideos() { return $$("#retarget-pair video"); }
  function stopPair() {
    pairEpoch += 1;
    pairPlaying = false;
    clearInterval(pairTimer);
    pairVideos().forEach((video) => video.pause());
    updatePlayButtons();
  }
  function renderRetarget(category) {
    stopPair();
    setCategoryState("retargeting", category);
    selectedRetargets = retargetClips.filter((clip) => categoryOf(clip) === category);
    const select = $("#retarget-action");
    select.replaceChildren();
    selectedRetargets.forEach((clip, index) => {
      const option = node("option", "", String(index + 1).padStart(2, "0") + " · " + clip.title);
      option.value = clip.id;
      select.append(option);
    });
    select.disabled = selectedRetargets.length === 0;
    selectRetarget(selectedRetargets[0]);
  }
  function selectRetarget(clip) {
    stopPair();
    const gallery = $("#retarget-pair");
    clearMedia(gallery);
    const index = selectedRetargets.indexOf(clip);
    $("#retarget-prev").disabled = index <= 0;
    $("#retarget-next").disabled = index < 0 || index >= selectedRetargets.length - 1;
    if (!clip) {
      gallery.append(node("p", "empty-gallery", "No retargeting videos in this category."));
      $("#retarget-meta").textContent = "";
      $("#retarget-count").textContent = "0 sequences";
      $("#retarget-provenance").textContent = "";
    } else {
      $("#retarget-action").value = clip.id;
      $("#retarget-meta").textContent = [clip.dataset, clip.sample ? "#" + clip.sample : ""].filter(Boolean).join(" · ");
      const totalVideos = selectedRetargets.reduce((total, entry) => total + pairKeys.filter((key) => entry[key]?.src).length, 0);
      $("#retarget-count").textContent = (index + 1) + " / " + selectedRetargets.length + " sequences · " + totalVideos + " videos";
      const pairs = pairKeys.filter((key) => clip[key]?.src);
      gallery.classList.toggle("is-single", pairs.length === 1);
      pairs.forEach((key, pairIndex) => {
        const item = {
          ...clip[key],
          id: clip[key].id || clip.id + "-" + key,
          title: key === "G1toG1" ? "G1 + G1" : "G1 + T1",
          category: categoryOf(clip),
          dataset: clip.dataset,
          sample: "",
        };
        gallery.append(makeCard(item, pairIndex, { pair: true, videoId: key === "G1toG1" ? "g1-video" : "t1-video" }));
      });
      $("#retarget-provenance").textContent = "Kinematic retargeting replay · not learned-policy execution.";
    }
    const hasVideo = pairVideos().length > 0;
    $("#pair-speed").disabled = !hasVideo;
    $("#pair-restart").disabled = !hasVideo;
    $("#pair-restart").setAttribute("aria-label", "Restart " + (pairVideos().length === 2 ? "both retargeting videos" : "retargeting video"));
    pairVideos().forEach((video) => { video.playbackRate = Number($("#pair-speed").value); });
    updatePlayButtons();
    icons();
  }
  function stageVideos(stage) { return $$("#" + stage + "-gallery video"); }
  function updatePlayButtons() {
    $$(".play-section").forEach((button) => {
      const videos = stageVideos(button.dataset.target);
      const playing = videos.some((video) => !video.paused);
      button.disabled = !videos.length;
      $("span", button).textContent = playing ? "Pause all" : "Play all";
      button.setAttribute("aria-label", (playing ? "Pause" : "Play") + " all " + stageLabels[button.dataset.target] + " videos");
      button.setAttribute("aria-pressed", String(playing));
    });
    const button = $("#pair-play");
    const videos = pairVideos();
    const playing = videos.some((video) => !video.paused);
    button.disabled = !videos.length;
    $("span", button).textContent = (playing ? "Pause" : "Play") + (videos.length === 2 ? " both" : " video");
    button.setAttribute("aria-pressed", String(playing));
  }

  async function openDialog(clip, source, trigger) {
    const time = source.currentTime;
    const rate = source.playbackRate;
    pauseAll();
    dialogEvents?.abort();
    dialogEvents = new AbortController();
    dialogTrigger = trigger;
    $("#dialog-title").textContent = clip.title || "Interaction video";
    $("#dialog-meta").textContent = [clip.dataset, clip.sample ? "#" + clip.sample : ""].filter(Boolean).join(" · ");
    const video = $("#dialog-video");
    video.muted = source.muted;
    video.loop = source.loop;
    video.volume = source.volume;
    video.poster = clip.poster || "";
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(time, Number.isFinite(video.duration) ? video.duration : time);
      video.playbackRate = rate;
    }, { once: true, signal: dialogEvents.signal });
    video.src = clip.src;
    video.load();
    $("#media-dialog").showModal();
    document.body.style.overflow = "hidden";
    await safePlay(video);
  }
  $("#dialog-close").addEventListener("click", () => $("#media-dialog").close());
  $("#media-dialog").addEventListener("close", () => {
    dialogEvents?.abort();
    $("#dialog-video").pause();
    $("#dialog-video").removeAttribute("src");
    $("#dialog-video").load();
    document.body.style.overflow = "";
    if (dialogTrigger?.isConnected) dialogTrigger.focus({ preventScroll: true });
  });
  $("#media-dialog").addEventListener("click", (event) => {
    if (event.target !== $("#media-dialog")) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  });

  document.title = (config.name || "DyadLink") + " | " + (config.title || config.heading || "An Interaction Is More Than Two");
  if (config.heading) $("#paper-heading").textContent = config.heading;
  if (config.subtitle) $("#paper-subtitle").textContent = config.subtitle;
  $("#resources").replaceChildren();
  for (const [label, url, glyph] of [["Paper", config.paperUrl, "file-text"], ["Code", config.codeUrl, "code-2"], [config.videoUrl ? "Project video" : "Explore videos", config.videoUrl || "#generation", "play"]]) {
    if (!url) continue;
    const item = node("a", "resource" + (glyph === "play" ? " resource-primary" : ""));
    item.append(icon(glyph), document.createTextNode(label));
    item.href = url;
    if (/^https?:\/\//i.test(url)) { item.target = "_blank"; item.rel = "noopener noreferrer"; }
    $("#resources").append(item);
  }
  if (config.authors?.length) {
    $("#authors").hidden = false;
    config.authors.forEach((author) => {
      const item = node(author.url ? "a" : "span", "", author.name);
      if (author.url) { item.href = author.url; item.rel = "noopener noreferrer"; }
      if (author.affiliation) item.title = author.affiliation;
      $("#authors").append(item);
    });
  }
  if (config.citation) {
    $("#citation").hidden = false;
    $("#bibtex").textContent = config.citation;
  }
  $("#copy-citation").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(config.citation);
      notify("Citation copied.");
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($("#bibtex"));
      selection.removeAllRanges();
      selection.addRange(range);
      notify("Citation selected. Press Ctrl+C (or Cmd+C) to copy.");
    }
  });
  const teaser = config.teaser?.src ? config.teaser : stageData["sim-to-real"][0];
  if (teaser) {
    $("#teaser-player").append(makeFrame(teaser, { autoplay: config.teaser?.autoplay === true }));
    $("#teaser-title").textContent = teaser.title;
    $("#teaser-note").textContent = teaser.note || "Real-world recording";
  } else $(".feature-film").hidden = true;
  const totals = {
    generation: stageData.generation.length,
    retargeting: retargetClips.reduce((sum, clip) => sum + pairKeys.filter((key) => clip[key]?.src).length, 0),
    control: stageData.control.length,
    "sim-to-real": stageData["sim-to-real"].length,
  };
  const total = Object.values(totals).reduce((sum, count) => sum + count, 0);
  $("#library-summary").append(node("span", "", total + " videos"), node("span", "", "InterHuman + CoDance"), node("span", "", "Four stages"));
  $$("[data-total]").forEach((element) => {
    element.textContent = String(totals[element.dataset.total]);
    element.setAttribute("aria-label", totals[element.dataset.total] + " videos");
  });
  for (const stage of ["generation", "retargeting", "control"]) {
    prepareCategories(stage);
    $$("[data-category]", $("#" + stage)).forEach((button) => button.addEventListener("click", () => {
      if (button.disabled || $("#" + stage).dataset.currentCategory === button.dataset.category) return;
      if (stage === "retargeting") renderRetarget(button.dataset.category);
      else renderGallery(stage, button.dataset.category);
    }));
    const preferred = stage === "generation" ? config.generation?.defaultCategory || "Interact" : "Interact";
    const buttons = $$("[data-category]", $("#" + stage)).filter((button) => !button.disabled);
    const category = buttons.find((button) => button.dataset.category === preferred)?.dataset.category || buttons[0]?.dataset.category || preferred;
    if (stage === "retargeting") renderRetarget(category);
    else renderGallery(stage, category);
  }
  renderGallery("sim-to-real");
  $("#retarget-action").addEventListener("change", (event) => selectRetarget(selectedRetargets.find((clip) => clip.id === event.target.value)));
  for (const [id, direction] of [["retarget-prev", -1], ["retarget-next", 1]]) {
    $("#" + id).addEventListener("click", () => {
      const index = selectedRetargets.findIndex((clip) => clip.id === $("#retarget-action").value);
      const clip = selectedRetargets[index + direction];
      if (clip) selectRetarget(clip);
    });
  }
  $$(".play-section").forEach((button) => button.addEventListener("click", async () => {
    const videos = stageVideos(button.dataset.target);
    if (videos.some((video) => !video.paused)) videos.forEach((video) => video.pause());
    else await Promise.all(videos.map((video) => safePlay(video)));
    updatePlayButtons();
  }));
  $("#pair-play").addEventListener("click", async () => {
    const videos = pairVideos();
    if (videos.some((video) => !video.paused)) { stopPair(); return; }
    if (!videos.length) return;
    const epoch = ++pairEpoch;
    pairPlaying = videos.length === 2;
    const outcomes = await Promise.all(videos.map((video) => safePlay(video)));
    if (epoch !== pairEpoch) return;
    if (!outcomes.every(Boolean)) { stopPair(); return; }
    if (videos.length === 1) { updatePlayButtons(); return; }
    const start = Math.min(...videos.map((video) => video.currentTime));
    videos.forEach((video) => { video.currentTime = start; });
    clearInterval(pairTimer);
    pairTimer = setInterval(() => {
      if (!pairPlaying || !videos.every((video) => video.isConnected)) { stopPair(); return; }
      const [a, b] = videos;
      if (a.paused || b.paused) { stopPair(); return; }
      const duration = Math.min(a.duration, b.duration);
      if (Number.isFinite(duration) && a.currentTime >= duration - 0.08) videos.forEach((video) => { video.currentTime = 0; });
      else if (Math.abs(a.currentTime - b.currentTime) > 0.12) b.currentTime = Math.min(a.currentTime, b.duration);
    }, 100);
    updatePlayButtons();
  });
  $("#pair-restart").addEventListener("click", () => {
    pairVideos().forEach((video) => { loadVideo(video); video.currentTime = 0; });
  });
  $("#pair-speed").addEventListener("change", () => pairVideos().forEach((video) => { video.playbackRate = Number($("#pair-speed").value); }));
  $("#pause-all").addEventListener("click", pauseAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseAll(); });
  reducedMotion.addEventListener?.("change", () => { if (reducedMotion.matches) pauseAll(); });
  function closeMenu() {
    $("#navigation").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
    $("#menu-toggle").setAttribute("aria-label", "Open navigation");
  }
  $("#menu-toggle").addEventListener("click", () => {
    const open = $("#navigation").classList.toggle("open");
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
    $("#menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  $("#navigation").addEventListener("click", (event) => { if (event.target.closest("a")) closeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });
  if ("IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) $$("#navigation a").forEach((link) => link.classList.toggle("active", link.hash === "#" + entry.target.id));
    }), { rootMargin: "-15% 0px -55% 0px" });
    $$("section[data-stage]").forEach((section) => navObserver.observe(section));
  }
  icons();
  window.DYADLINK_READY = true;
})();
