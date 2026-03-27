// IM3 Tutor — Live AI Tutor Widget
// Modes: Live (voice + screen) | Text (chat fallback)

declare const __WIDGET_CSS__: string;

interface TutorConfig {
  id: string;
  projectName: string;
  welcomeMessage: string;
  theme: string;
  accentColor: string;
  language: string;
}

// ============================================================
// SVG Icons
// ============================================================

const ICONS = {
  chat: `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>`,
  send: `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
  mic: `<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" fill="currentColor"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" fill="currentColor"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.55-.9l4.17 4.18L21 19.73 4.27 3z" fill="currentColor"/></svg>`,
  screen: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" fill="currentColor"/></svg>`,
  screenOff: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" fill="currentColor"/><line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2"/></svg>`,
  live: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>`,
};

// ============================================================
// Init
// ============================================================

(function () {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const tutorId = script.getAttribute("data-tutor");
  if (!tutorId) {
    console.error("[IM3 Tutor] Missing data-tutor attribute");
    return;
  }

  const dataTheme = script.getAttribute("data-theme") ?? "light";
  const dataPosition = script.getAttribute("data-position") ?? "bottom-right";
  const dataColor = script.getAttribute("data-color") ?? "";

  const scriptSrc = script.src;
  const apiBase = scriptSrc.replace(/\/widget\.js(\?.*)?$/, "");
  const wsBase = apiBase.replace(/^http/, "ws");

  // ============================================================
  // Shadow DOM Setup
  // ============================================================

  const host = document.createElement("div");
  host.id = "im3-tutor-widget";
  host.setAttribute("data-theme", dataTheme);

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = __WIDGET_CSS__;
  shadow.appendChild(style);

  document.body.appendChild(host);

  // ============================================================
  // State
  // ============================================================

  let config: TutorConfig | null = null;
  let isOpen = false;
  let mode: "select" | "live" | "text" = "select";

  // Live mode state
  let ws: WebSocket | null = null;
  let audioContext: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let screenStream: MediaStream | null = null;
  let micProcessor: ScriptProcessorNode | null = null;
  let isMicOn = false;
  let isScreenOn = false;
  let screenInterval: ReturnType<typeof setInterval> | null = null;
  let audioQueue: string[] = [];
  let isPlayingAudio = false;

  // Text mode state
  const textMessages: Array<{ role: string; content: string; id?: string }> = [];
  let isTextLoading = false;
  const sessionId = (() => {
    const key = `im3-tutor-session-${tutorId}`;
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  })();

  // ============================================================
  // DOM refs
  // ============================================================

  const container = document.createElement("div");
  container.className = `tutor-container ${dataPosition}`;
  shadow.appendChild(container);

  const button = document.createElement("button");
  button.className = "tutor-button";
  button.innerHTML = ICONS.chat;
  button.setAttribute("aria-label", "Open tutor");
  container.appendChild(button);

  let windowEl: HTMLDivElement | null = null;

  // ============================================================
  // Fetch Config
  // ============================================================

  async function fetchConfig(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/tutor/${tutorId}/config`);
      if (!res.ok) throw new Error("Failed to fetch config");
      config = (await res.json()) as TutorConfig;
      const accent = dataColor || config.accentColor;
      host.style.setProperty("--tutor-accent", accent);
      button.style.background = accent;
    } catch (err) {
      console.error("[IM3 Tutor] Config error:", err);
    }
  }

  fetchConfig();

  // ============================================================
  // Toggle Window
  // ============================================================

  button.addEventListener("click", () => {
    isOpen = !isOpen;
    if (isOpen) {
      button.style.display = "none";
      if (!windowEl) createWindow();
      else windowEl.style.display = "flex";
    } else {
      closeWindow();
    }
  });

  function closeWindow(): void {
    button.style.display = "flex";
    if (windowEl) windowEl.style.display = "none";
    stopLive();
    isOpen = false;
  }

  // ============================================================
  // Main Window
  // ============================================================

  function createWindow(): void {
    windowEl = document.createElement("div");
    windowEl.className = "tutor-window";
    container.appendChild(windowEl);
    showModeSelect();
  }

  // ============================================================
  // Mode Select Screen
  // ============================================================

  function showModeSelect(): void {
    if (!windowEl) return;
    mode = "select";
    windowEl.innerHTML = "";

    // Header
    windowEl.appendChild(makeHeader(config?.projectName ?? "Tutor IA"));

    const body = document.createElement("div");
    body.className = "tutor-mode-select";

    const title = document.createElement("p");
    title.className = "tutor-mode-title";
    title.textContent = config?.language === "en"
      ? "How would you like to interact?"
      : "¿Cómo quieres interactuar?";
    body.appendChild(title);

    // Live button
    const liveBtn = document.createElement("button");
    liveBtn.className = "tutor-mode-btn tutor-mode-live";
    liveBtn.innerHTML = `
      <span class="tutor-mode-icon">${ICONS.mic}</span>
      <span class="tutor-mode-label">${config?.language === "en" ? "Live Tutor" : "Tutor en Vivo"}</span>
      <span class="tutor-mode-desc">${config?.language === "en" ? "Voice + screen sharing" : "Voz + compartir pantalla"}</span>
    `;
    liveBtn.addEventListener("click", () => startLiveMode());
    body.appendChild(liveBtn);

    // Text button
    const textBtn = document.createElement("button");
    textBtn.className = "tutor-mode-btn tutor-mode-text";
    textBtn.innerHTML = `
      <span class="tutor-mode-icon">${ICONS.chat}</span>
      <span class="tutor-mode-label">${config?.language === "en" ? "Text Chat" : "Chat de Texto"}</span>
      <span class="tutor-mode-desc">${config?.language === "en" ? "Type your questions" : "Escribe tus preguntas"}</span>
    `;
    textBtn.addEventListener("click", () => showTextMode());
    body.appendChild(textBtn);

    windowEl.appendChild(body);
  }

  // ============================================================
  // Live Mode
  // ============================================================

  function startLiveMode(): void {
    if (!windowEl) return;
    mode = "live";
    windowEl.innerHTML = "";

    windowEl.appendChild(makeHeader(config?.projectName ?? "Tutor IA"));

    // Status area
    const status = document.createElement("div");
    status.className = "tutor-live-status";
    status.id = "live-status";

    const statusDot = document.createElement("span");
    statusDot.className = "tutor-live-dot connecting";
    status.appendChild(statusDot);

    const statusText = document.createElement("span");
    statusText.textContent = config?.language === "en" ? "Connecting..." : "Conectando...";
    statusText.id = "live-status-text";
    status.appendChild(statusText);

    windowEl.appendChild(status);

    // Transcript area
    const transcript = document.createElement("div");
    transcript.className = "tutor-live-transcript";
    transcript.id = "live-transcript";
    windowEl.appendChild(transcript);

    // Controls
    const controls = document.createElement("div");
    controls.className = "tutor-live-controls";

    const micBtn = document.createElement("button");
    micBtn.className = "tutor-control-btn";
    micBtn.id = "mic-btn";
    micBtn.innerHTML = ICONS.micOff;
    micBtn.title = config?.language === "en" ? "Turn on microphone" : "Activar micrófono";
    micBtn.addEventListener("click", toggleMic);
    controls.appendChild(micBtn);

    const screenBtn = document.createElement("button");
    screenBtn.className = "tutor-control-btn";
    screenBtn.id = "screen-btn";
    screenBtn.innerHTML = ICONS.screenOff;
    screenBtn.title = config?.language === "en" ? "Share screen" : "Compartir pantalla";
    screenBtn.addEventListener("click", toggleScreen);
    controls.appendChild(screenBtn);

    const endBtn = document.createElement("button");
    endBtn.className = "tutor-control-btn tutor-end-btn";
    endBtn.textContent = config?.language === "en" ? "End" : "Terminar";
    endBtn.addEventListener("click", () => {
      stopLive();
      showModeSelect();
    });
    controls.appendChild(endBtn);

    windowEl.appendChild(controls);

    // Powered by
    windowEl.appendChild(makePowered());

    // Connect WebSocket
    connectWS();
  }

  function connectWS(): void {
    ws = new WebSocket(`${wsBase}/ws/tutor`);

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "init", tutorId }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        data?: string;
        message?: string;
        projectName?: string;
      };

      switch (msg.type) {
        case "ready":
          updateLiveStatus("connected",
            config?.language === "en" ? "Connected — start talking!" : "Conectado — ¡empieza a hablar!");
          break;

        case "audio":
          if (msg.data) {
            audioQueue.push(msg.data);
            playAudioQueue();
          }
          break;

        case "text":
          if (msg.message) appendTranscript("assistant", msg.message);
          break;

        case "turn_complete":
          // Gemini finished a response
          break;

        case "error":
          updateLiveStatus("error", msg.message ?? "Error");
          break;
      }
    };

    ws.onclose = () => {
      updateLiveStatus("disconnected",
        config?.language === "en" ? "Disconnected" : "Desconectado");
    };

    ws.onerror = () => {
      updateLiveStatus("error",
        config?.language === "en" ? "Connection error" : "Error de conexión");
    };
  }

  function updateLiveStatus(state: string, text: string): void {
    const dot = shadow.getElementById("live-status")?.querySelector(".tutor-live-dot");
    const label = shadow.getElementById("live-status-text");
    if (dot) {
      dot.className = `tutor-live-dot ${state}`;
    }
    if (label) label.textContent = text;
  }

  function appendTranscript(role: string, text: string): void {
    const el = shadow.getElementById("live-transcript");
    if (!el) return;

    const msg = document.createElement("div");
    msg.className = `tutor-msg ${role}`;
    msg.textContent = text;
    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;
  }

  // ============================================================
  // Microphone
  // ============================================================

  async function toggleMic(): Promise<void> {
    if (isMicOn) {
      stopMic();
    } else {
      await startMic();
    }
  }

  async function startMic(): Promise<void> {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      });

      audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(micStream);

      // Use ScriptProcessor to get raw PCM data
      micProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      micProcessor.onaudioprocess = (e) => {
        if (!isMicOn || !ws || ws.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16 PCM
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]!));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Convert to base64
        const bytes = new Uint8Array(int16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        const base64 = btoa(binary);

        ws.send(JSON.stringify({ type: "audio", data: base64 }));
      };

      source.connect(micProcessor);
      micProcessor.connect(audioContext.destination);

      isMicOn = true;
      const btn = shadow.getElementById("mic-btn");
      if (btn) {
        btn.innerHTML = ICONS.mic;
        btn.classList.add("active");
      }
    } catch (err) {
      console.error("[IM3 Tutor] Mic error:", err);
    }
  }

  function stopMic(): void {
    isMicOn = false;
    micProcessor?.disconnect();
    micProcessor = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    audioContext?.close();
    audioContext = null;

    const btn = shadow.getElementById("mic-btn");
    if (btn) {
      btn.innerHTML = ICONS.micOff;
      btn.classList.remove("active");
    }
  }

  // ============================================================
  // Screen Sharing
  // ============================================================

  async function toggleScreen(): Promise<void> {
    if (isScreenOn) {
      stopScreen();
    } else {
      await startScreen();
    }
  }

  async function startScreen(): Promise<void> {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, // 1 FPS is enough for screen guidance
      });

      // Capture frames and send to server
      const video = document.createElement("video");
      video.srcObject = screenStream;
      video.play();

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;

      screenInterval = setInterval(() => {
        if (!isScreenOn || !ws || ws.readyState !== WebSocket.OPEN) return;
        if (video.readyState < 2) return;

        // Resize to reasonable size (720p max width)
        const scale = Math.min(1, 720 / video.videoWidth);
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert to JPEG base64
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        const base64 = dataUrl.split(",")[1];
        if (base64) {
          ws.send(JSON.stringify({ type: "screen", data: base64 }));
        }
      }, 2000); // Send frame every 2 seconds

      // Handle user stopping share via browser UI
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stopScreen();
      });

      isScreenOn = true;
      const btn = shadow.getElementById("screen-btn");
      if (btn) {
        btn.innerHTML = ICONS.screen;
        btn.classList.add("active");
      }
    } catch (err) {
      console.error("[IM3 Tutor] Screen share error:", err);
    }
  }

  function stopScreen(): void {
    isScreenOn = false;
    if (screenInterval) {
      clearInterval(screenInterval);
      screenInterval = null;
    }
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;

    const btn = shadow.getElementById("screen-btn");
    if (btn) {
      btn.innerHTML = ICONS.screenOff;
      btn.classList.remove("active");
    }
  }

  // ============================================================
  // Audio Playback (play Gemini voice responses)
  // ============================================================

  async function playAudioQueue(): Promise<void> {
    if (isPlayingAudio || audioQueue.length === 0) return;
    isPlayingAudio = true;

    while (audioQueue.length > 0) {
      const base64 = audioQueue.shift()!;
      await playBase64Audio(base64);
    }

    isPlayingAudio = false;
  }

  function playBase64Audio(base64: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        // PCM16 mono 24kHz (Gemini output format)
        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i]! / 0x8000;
        }

        const playbackCtx = new AudioContext({ sampleRate: 24000 });
        const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
        buffer.copyToChannel(float32, 0);

        const source = playbackCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(playbackCtx.destination);
        source.onended = () => {
          playbackCtx.close();
          resolve();
        };
        source.start();
      } catch {
        resolve();
      }
    });
  }

  // ============================================================
  // Stop Live Session
  // ============================================================

  function stopLive(): void {
    stopMic();
    stopScreen();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end" }));
      ws.close();
    }
    ws = null;
    audioQueue = [];
    isPlayingAudio = false;
  }

  // ============================================================
  // Text Mode (chat fallback)
  // ============================================================

  function showTextMode(): void {
    if (!windowEl) return;
    mode = "text";
    windowEl.innerHTML = "";

    windowEl.appendChild(makeHeader(config?.projectName ?? "Tutor IA"));

    // Messages area
    const messagesEl = document.createElement("div");
    messagesEl.className = "tutor-messages";
    messagesEl.id = "text-messages";

    if (textMessages.length === 0 && config?.welcomeMessage) {
      textMessages.push({ role: "assistant", content: config.welcomeMessage });
    }

    windowEl.appendChild(messagesEl);
    renderTextMessages();

    // Input area
    const inputArea = document.createElement("div");
    inputArea.className = "tutor-input-area";

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "tutor-back-btn";
    backBtn.textContent = "←";
    backBtn.title = config?.language === "en" ? "Back" : "Volver";
    backBtn.addEventListener("click", () => showModeSelect());
    inputArea.appendChild(backBtn);

    const input = document.createElement("textarea");
    input.className = "tutor-input";
    input.id = "text-input";
    input.placeholder = config?.language === "en" ? "Type your question..." : "Escribe tu pregunta...";
    input.rows = 1;
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 80) + "px";
    });
    inputArea.appendChild(input);

    const sendBtn = document.createElement("button");
    sendBtn.className = "tutor-send";
    sendBtn.id = "text-send";
    sendBtn.innerHTML = ICONS.send;
    sendBtn.addEventListener("click", sendTextMessage);
    inputArea.appendChild(sendBtn);

    windowEl.appendChild(inputArea);
    windowEl.appendChild(makePowered());

    setTimeout(() => input.focus(), 100);
  }

  function renderTextMessages(): void {
    const el = shadow.getElementById("text-messages");
    if (!el) return;
    el.innerHTML = "";

    for (const msg of textMessages) {
      const bubble = document.createElement("div");
      bubble.className = `tutor-msg ${msg.role}`;
      bubble.textContent = msg.content;
      el.appendChild(bubble);
    }

    if (isTextLoading) {
      const typing = document.createElement("div");
      typing.className = "tutor-typing";
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("div");
        dot.className = "tutor-typing-dot";
        typing.appendChild(dot);
      }
      el.appendChild(typing);
    }

    el.scrollTop = el.scrollHeight;
  }

  async function sendTextMessage(): Promise<void> {
    const input = shadow.getElementById("text-input") as HTMLTextAreaElement | null;
    const sendBtn = shadow.getElementById("text-send") as HTMLButtonElement | null;
    if (!input || isTextLoading) return;

    const text = input.value.trim();
    if (!text) return;

    textMessages.push({ role: "user", content: text });
    input.value = "";
    input.style.height = "auto";
    isTextLoading = true;
    if (sendBtn) sendBtn.disabled = true;
    renderTextMessages();

    try {
      const res = await fetch(`${apiBase}/api/tutor/${tutorId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });

      if (!res.ok) throw new Error("Request failed");
      const data = await res.json();
      textMessages.push({ role: "assistant", content: data.reply, id: data.messageId });
    } catch {
      textMessages.push({
        role: "assistant",
        content: config?.language === "en"
          ? "Sorry, an error occurred. Please try again."
          : "Lo siento, ocurrió un error. Intenta de nuevo.",
      });
    } finally {
      isTextLoading = false;
      if (sendBtn) sendBtn.disabled = false;
      renderTextMessages();
      input.focus();
    }
  }

  // ============================================================
  // Shared UI Helpers
  // ============================================================

  function makeHeader(title: string): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "tutor-header";

    const h3 = document.createElement("h3");
    h3.className = "tutor-header-title";
    h3.textContent = title;
    header.appendChild(h3);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tutor-header-close";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.addEventListener("click", closeWindow);
    header.appendChild(closeBtn);

    return header;
  }

  function makePowered(): HTMLDivElement {
    const powered = document.createElement("div");
    powered.className = "tutor-powered";
    powered.textContent = "Powered by IM3 Tutor";
    return powered;
  }
})();
