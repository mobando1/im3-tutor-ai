// IM3 Tutor — Embeddable Chat Widget
// Built with vanilla TypeScript + Shadow DOM

declare const __WIDGET_CSS__: string;

interface TutorConfig {
  id: string;
  projectName: string;
  welcomeMessage: string;
  theme: string;
  accentColor: string;
  language: string;
}

interface ChatResponse {
  reply: string;
  conversationId: string;
  messageId: string;
  docsUsed: Array<{ documentId: string; chunkIndex: number }>;
}

// ============================================================
// SVG Icons
// ============================================================

const ICON_CHAT = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

// ============================================================
// Initialization
// ============================================================

(function () {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  // Read configuration from data attributes
  const tutorId = script.getAttribute("data-tutor");
  if (!tutorId) {
    console.error("[IM3 Tutor] Missing data-tutor attribute");
    return;
  }

  const dataTheme = script.getAttribute("data-theme") ?? "light";
  const dataPosition = script.getAttribute("data-position") ?? "bottom-right";
  const dataLanguage = script.getAttribute("data-language") ?? "es";
  const dataColor = script.getAttribute("data-color") ?? "";

  // Derive API base URL from the script's src
  const scriptSrc = script.src;
  const apiBase = scriptSrc.replace(/\/widget\.js(\?.*)?$/, "");

  // Session ID: persist across page navigations within the same browser session
  const SESSION_KEY = `im3-tutor-session-${tutorId}`;
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ============================================================
  // Create Shadow DOM host
  // ============================================================

  const host = document.createElement("div");
  host.id = "im3-tutor-widget";
  const shadow = host.attachShadow({ mode: "closed" });

  // Inject CSS
  const style = document.createElement("style");
  style.textContent = __WIDGET_CSS__;
  shadow.appendChild(style);

  // Set theme attribute on host for CSS :host([data-theme="dark"])
  host.setAttribute("data-theme", dataTheme);

  document.body.appendChild(host);

  // ============================================================
  // State
  // ============================================================

  let config: TutorConfig | null = null;
  let isOpen = false;
  let isLoading = false;
  const messages: Array<{ role: string; content: string; id?: string }> = [];

  // ============================================================
  // DOM Elements
  // ============================================================

  const container = document.createElement("div");
  container.className = `tutor-container ${dataPosition}`;
  shadow.appendChild(container);

  // Floating button
  const button = document.createElement("button");
  button.className = "tutor-button";
  button.innerHTML = ICON_CHAT;
  button.setAttribute("aria-label", "Open tutor chat");
  container.appendChild(button);

  // Chat window (created lazily)
  let windowEl: HTMLDivElement | null = null;
  let messagesEl: HTMLDivElement | null = null;
  let inputEl: HTMLTextAreaElement | null = null;
  let sendBtn: HTMLButtonElement | null = null;

  // ============================================================
  // Fetch Config
  // ============================================================

  async function fetchConfig(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/tutor/${tutorId}/config`);
      if (!res.ok) throw new Error("Failed to fetch config");
      config = (await res.json()) as TutorConfig;

      // Apply accent color
      const accentColor = dataColor || config.accentColor;
      host.style.setProperty("--tutor-accent", accentColor);
      button.style.background = accentColor;
    } catch (err) {
      console.error("[IM3 Tutor] Failed to load config:", err);
    }
  }

  fetchConfig();

  // ============================================================
  // Render Chat Window
  // ============================================================

  function createChatWindow(): void {
    windowEl = document.createElement("div");
    windowEl.className = "tutor-window";

    // Header
    const header = document.createElement("div");
    header.className = "tutor-header";

    const title = document.createElement("h3");
    title.className = "tutor-header-title";
    title.textContent = config?.projectName ?? "Tutor IA";
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tutor-header-close";
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.addEventListener("click", toggleChat);
    header.appendChild(closeBtn);

    windowEl.appendChild(header);

    // Messages area
    messagesEl = document.createElement("div");
    messagesEl.className = "tutor-messages";
    windowEl.appendChild(messagesEl);

    // Show welcome message if first open
    if (messages.length === 0 && config?.welcomeMessage) {
      messages.push({ role: "assistant", content: config.welcomeMessage });
    }

    renderMessages();

    // Input area
    const inputArea = document.createElement("div");
    inputArea.className = "tutor-input-area";

    inputEl = document.createElement("textarea");
    inputEl.className = "tutor-input";
    inputEl.placeholder =
      config?.language === "en"
        ? "Type your question..."
        : "Escribe tu pregunta...";
    inputEl.rows = 1;
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    inputEl.addEventListener("input", () => {
      if (inputEl) {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
      }
    });
    inputArea.appendChild(inputEl);

    sendBtn = document.createElement("button");
    sendBtn.className = "tutor-send";
    sendBtn.innerHTML = ICON_SEND;
    sendBtn.setAttribute("aria-label", "Send message");
    sendBtn.addEventListener("click", sendMessage);
    inputArea.appendChild(sendBtn);

    windowEl.appendChild(inputArea);

    // Powered by
    const powered = document.createElement("div");
    powered.className = "tutor-powered";
    powered.textContent = "Powered by IM3 Tutor";
    windowEl.appendChild(powered);

    container.appendChild(windowEl);

    // Focus input
    setTimeout(() => inputEl?.focus(), 100);
  }

  // ============================================================
  // Render Messages
  // ============================================================

  function renderMessages(): void {
    if (!messagesEl) return;

    messagesEl.innerHTML = "";

    for (const msg of messages) {
      const bubble = document.createElement("div");
      bubble.className = `tutor-msg ${msg.role}`;
      bubble.textContent = msg.content;
      messagesEl.appendChild(bubble);
    }

    // Show typing indicator if loading
    if (isLoading) {
      const typing = document.createElement("div");
      typing.className = "tutor-typing";
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("div");
        dot.className = "tutor-typing-dot";
        typing.appendChild(dot);
      }
      messagesEl.appendChild(typing);
    }

    // Scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ============================================================
  // Toggle Chat
  // ============================================================

  function toggleChat(): void {
    isOpen = !isOpen;

    if (isOpen) {
      button.style.display = "none";
      if (!windowEl) {
        createChatWindow();
      } else {
        windowEl.style.display = "flex";
        setTimeout(() => inputEl?.focus(), 100);
      }
    } else {
      button.style.display = "flex";
      if (windowEl) {
        windowEl.style.display = "none";
      }
    }
  }

  button.addEventListener("click", toggleChat);

  // ============================================================
  // Send Message
  // ============================================================

  async function sendMessage(): Promise<void> {
    if (!inputEl || isLoading) return;

    const text = inputEl.value.trim();
    if (text.length === 0) return;

    // Add user message
    messages.push({ role: "user", content: text });
    inputEl.value = "";
    inputEl.style.height = "auto";
    isLoading = true;

    if (sendBtn) sendBtn.disabled = true;

    renderMessages();

    try {
      const res = await fetch(`${apiBase}/api/tutor/${tutorId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });

      if (!res.ok) {
        throw new Error("Chat request failed");
      }

      const data = (await res.json()) as ChatResponse;
      messages.push({
        role: "assistant",
        content: data.reply,
        id: data.messageId,
      });
    } catch (err) {
      const errorMsg =
        config?.language === "en"
          ? "Sorry, an error occurred. Please try again."
          : "Lo siento, ocurrio un error. Intenta de nuevo.";
      messages.push({ role: "assistant", content: errorMsg });
      console.error("[IM3 Tutor] Chat error:", err);
    } finally {
      isLoading = false;
      if (sendBtn) sendBtn.disabled = false;
      renderMessages();
      inputEl?.focus();
    }
  }
})();
