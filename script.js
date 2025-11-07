/* Get references to DOM elements */
const categoryFilter = document.getElementById("categoryFilter");
const productsContainer = document.getElementById("productsContainer");
const chatForm = document.getElementById("chatForm");
const chatWindow = document.getElementById("chatWindow");
const generateBtn = document.getElementById("generateRoutine");

/* Show initial placeholder until user selects a category */
productsContainer.innerHTML = `
  <div class="placeholder-message">
    Select a category to view products
  </div>
`;
// In-memory cache and selection state
let allProducts = [];
const selectedProductIds = new Set();
// Local storage key for persisted selections
const STORAGE_KEY = "loreal_selected_products_v1";

function saveSelectedToStorage() {
  try {
    const arr = Array.from(selectedProductIds);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn("Could not save selected products to localStorage:", err);
  }
}

function loadSelectedFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((v) => selectedProductIds.add(Number(v)));
    }
  } catch (err) {
    console.warn("Could not load selected products from localStorage:", err);
  }
}

function clearSelectedFromStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("Could not remove selected products from localStorage:", err);
  }
  // clear in-memory set and update UI
  selectedProductIds.clear();
  // Unmark any visible product cards
  const cards = productsContainer.querySelectorAll(".product-card.selected");
  cards.forEach((c) => {
    c.classList.remove("selected");
    c.setAttribute("aria-pressed", "false");
    const info = c.querySelector(".info-btn");
    if (info) info.setAttribute("aria-expanded", "false");
    const desc = c.querySelector(".product-desc");
    if (desc) {
      desc.classList.remove("open");
      desc.setAttribute("aria-hidden", "true");
    }
  });
  renderSelectedProducts();
}

/* Utility: find product by id in cache */
function findProductById(id) {
  return allProducts.find((p) => Number(p.id) === Number(id));
}

/* Load product data from JSON file */
async function loadProducts() {
  if (allProducts.length > 0) return allProducts;
  const response = await fetch("products.json");
  const data = await response.json();
  allProducts = data.products;
  return allProducts;
}

// Conversation history for follow-up chats. Start with a helpful system prompt.

// Conversation history for follow-up chats. Start with a helpful system prompt.
const systemMessage = {
  role: "system",
  content:
    "You are an expert skincare and beauty routine assistant working for L'Or\u00e9al. Be helpful, concise, and base answers only on the conversation context and provided products. When asked, provide step-by-step routines, usage tips, and product guidance for skincare, haircare, makeup, fragrance, and related topics.",
};

const conversationMessages = [systemMessage];

// Helper to append chat messages to the chat window
function appendChatMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-msg chat-${role}`;
  const who = document.createElement("div");
  who.className = "chat-role";
  who.textContent =
    role === "user" ? "You" : role === "assistant" ? "Advisor" : "System";
  const content = document.createElement("div");
  content.className = "chat-content";
  content.innerHTML = `<pre style="white-space:pre-wrap">${escapeHTML(
    text
  )}</pre>`;
  wrapper.appendChild(who);
  wrapper.appendChild(content);
  chatWindow.appendChild(wrapper);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

generateBtn.addEventListener("click", async () => {
  const selectedIds = Array.from(selectedProductIds);
  if (selectedIds.length === 0) {
    appendChatMessage(
      "assistant",
      "Please select at least one product to generate a routine."
    );
    return;
  }

  // Build the product payload (only fields we want to send)
  const selectedProducts = selectedIds
    .map((id) => findProductById(Number(id)))
    .filter(Boolean)
    .map((p) => ({
      name: p.name,
      brand: p.brand,
      category: p.category,
      description: p.description,
    }));

  // Add the user message with the selected products to the conversation history
  const userMsg = {
    role: "user",
    content: `Here are the selected products as JSON. Use only these products to build a clear, step-by-step routine (separate morning/evening when applicable). Return plain text.\n\n${JSON.stringify(
      selectedProducts,
      null,
      2
    )}`,
  };
  conversationMessages.push(userMsg);

  // show a local user message and loading assistant message
  appendChatMessage("user", "Generate a routine for the selected products.");
  appendChatMessage("assistant", "Generating routine…");

  try {
    const routine = await generateWithOpenAI(conversationMessages);
    // replace the last assistant loading message with actual content
    // remove the last assistant message node
    const msgs = chatWindow.querySelectorAll(".chat-msg");
    const last = msgs[msgs.length - 1];
    if (last && last.querySelector(".chat-role").textContent === "Advisor") {
      last.querySelector(
        ".chat-content"
      ).innerHTML = `<pre style="white-space:pre-wrap">${escapeHTML(
        routine
      )}</pre>`;
    } else {
      appendChatMessage("assistant", routine);
    }

    // store assistant reply in conversation history
    conversationMessages.push({ role: "assistant", content: routine });
  } catch (err) {
    console.error(err);
    appendChatMessage(
      "assistant",
      "Error generating routine. Check console for details."
    );
  }
});

// Generic function to call OpenAI with a messages array
async function generateWithOpenAI(messages) {
  // Prefer sending requests to the Cloudflare Worker proxy so the API key
  // doesn't need to be exposed client-side. Set WORKER_URL to your worker.
  const WORKER_URL = "https://cloudflare-worker.kntabataba.workers.dev/";

  const body = { model: "gpt-4o", messages, max_tokens: 800 };

  // If the worker URL is set, POST there. Otherwise fall back to direct OpenAI.
  const useWorker = Boolean(WORKER_URL);
  const targetUrl = useWorker
    ? WORKER_URL
    : "https://api.openai.com/v1/chat/completions";

  const headers = { "Content-Type": "application/json" };
  if (!useWorker) {
    // Direct OpenAI requires the client-side key (only for local/dev). Prefer worker.
    if (typeof OPENAI_API_KEY === "undefined") {
      throw new Error(
        "OPENAI_API_KEY is not defined. Please add secrets.js with your key or configure a worker."
      );
    }
    headers["Authorization"] = `Bearer ${OPENAI_API_KEY}`;
  }

  const resp = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API error: ${resp.status} ${txt}`);
  }

  // Accept multiple response shapes: the worker may forward OpenAI JSON,
  // or it may return a simplified { content: "..." } or plain text.
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    // Not JSON — return raw text
    return await resp.text();
  }

  // OpenAI-like response
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  // Worker-friendly shapes
  if (typeof data === "string") return data;
  if (data?.content) return data.content;
  if (data?.result) return data.result;

  // Otherwise return a pretty-printed JSON string
  return JSON.stringify(data);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* --- Chat follow-ups: send user messages and preserve history --- */
const userInput = document.getElementById("userInput");
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;

  // append user message to UI and conversation
  appendChatMessage("user", text);
  conversationMessages.push({ role: "user", content: text });
  userInput.value = "";

  // show assistant loading
  appendChatMessage("assistant", "Thinking…");

  try {
    const reply = await generateWithOpenAI(conversationMessages);
    // replace last assistant loading message
    const msgs = chatWindow.querySelectorAll(".chat-msg");
    const last = msgs[msgs.length - 1];
    if (last && last.querySelector(".chat-role").textContent === "Advisor") {
      last.querySelector(
        ".chat-content"
      ).innerHTML = `<pre style="white-space:pre-wrap">${escapeHTML(
        reply
      )}</pre>`;
    } else {
      appendChatMessage("assistant", reply);
    }

    conversationMessages.push({ role: "assistant", content: reply });
  } catch (err) {
    console.error(err);
    appendChatMessage(
      "assistant",
      "Error: could not get a response. See console for details."
    );
  }
});

function toggleDescription(productId) {
  const idNum = Number(productId);
  const card = productsContainer.querySelector(
    `.product-card[data-id="${idNum}"]`
  );
  if (!card) return;
  const desc = card.querySelector(`#desc-${idNum}`);
  const btn = card.querySelector(".info-btn");
  if (!desc || !btn) return;

  const isOpen = desc.classList.contains("open");
  if (isOpen) {
    desc.classList.remove("open");
    desc.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.title = "Show description";
  } else {
    desc.classList.add("open");
    desc.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    btn.title = "Hide description";
  }
}

function toggleProductSelection(productId) {
  const idNum = Number(productId);
  const card = productsContainer.querySelector(
    `.product-card[data-id="${idNum}"]`
  );
  if (selectedProductIds.has(idNum)) {
    selectedProductIds.delete(idNum);
    if (card) {
      card.classList.remove("selected");
      card.setAttribute("aria-pressed", "false");
    }
  } else {
    selectedProductIds.add(idNum);
    if (card) {
      card.classList.add("selected");
      card.setAttribute("aria-pressed", "true");
    }
  }
  // persist selection and update UI
  saveSelectedToStorage();
  renderSelectedProducts();
}

/* Create HTML for displaying product cards */
function displayProducts(products) {
  productsContainer.innerHTML = products
    .map((product) => {
      const isSelected = selectedProductIds.has(Number(product.id));
      return `
      <div class="product-card ${isSelected ? "selected" : ""}" data-id="${
        product.id
      }" tabindex="0" role="button" aria-pressed="${isSelected}">
        <button class="info-btn" aria-controls="desc-${
          product.id
        }" aria-expanded="false" title="Show description">i</button>
        <img src="${product.image}" alt="${product.name}">
        <div class="product-info">
          <h3>${product.name}</h3>
          <p>${product.brand}</p>
        </div>
        <div id="desc-${product.id}" class="product-desc" aria-hidden="true">${
        product.description
      }</div>
      </div>
    `;
    })
    .join("");

  // Attach event handlers to the newly rendered cards and info buttons
  attachProductCardHandlers();
  attachInfoHandlers();
}

function attachProductCardHandlers() {
  const cards = productsContainer.querySelectorAll(".product-card");
  cards.forEach((card) => {
    const id = card.getAttribute("data-id");
    // click toggles selection
    card.addEventListener("click", () => toggleProductSelection(Number(id)));
    // keyboard accessibility: Enter or Space toggles selection
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleProductSelection(Number(id));
      }
    });
  });
}

function attachInfoHandlers() {
  const infoButtons = productsContainer.querySelectorAll(".info-btn");
  infoButtons.forEach((btn) => {
    // prevent the card click from firing when clicking the info button
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".product-card");
      const id = card && card.getAttribute("data-id");
      toggleDescription(Number(id));
    });

    // keyboard: Enter or Space toggles description
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest(".product-card");
        const id = card && card.getAttribute("data-id");
        toggleDescription(Number(id));
      }
    });
  });
}

function renderSelectedProducts() {
  const container = document.getElementById("selectedProductsList");
  if (selectedProductIds.size === 0) {
    container.innerHTML = `<p style="color:#666">No products selected</p>`;
    // disable clear button when nothing is selected
    const clearBtnEmpty = document.getElementById("clearSelections");
    if (clearBtnEmpty) clearBtnEmpty.disabled = true;
    return;
  }

  const items = Array.from(selectedProductIds).map((id) => {
    const product = findProductById(id);
    if (!product) return "";
    return `
      <div class="selected-item" data-id="${product.id}">
        <span>${product.name}</span>
        <button class="remove-btn" title="Remove ${product.name}" aria-label="Remove ${product.name}">×</button>
      </div>
    `;
  });

  container.innerHTML = items.join("");

  // Attach remove handlers
  const removeButtons = container.querySelectorAll(".remove-btn");
  removeButtons.forEach((btn) => {
    const parent = btn.closest(".selected-item");
    const id = parent && parent.getAttribute("data-id");
    btn.addEventListener("click", () => {
      toggleProductSelection(Number(id));
    });
  });

  // enable clear button when there are selections
  const clearBtn = document.getElementById("clearSelections");
  if (clearBtn) clearBtn.disabled = selectedProductIds.size === 0;
}

/* Filter and display products when category changes */
categoryFilter.addEventListener("change", async (e) => {
  const products = await loadProducts();
  const selectedCategory = e.target.value;

  /* filter() creates a new array containing only products 
     where the category matches what the user selected */
  const filteredProducts = products.filter(
    (product) => product.category === selectedCategory
  );

  displayProducts(filteredProducts);
});

/* (The real chat form handler is implemented further below and preserves conversation history) */

// Exported-ish init: load all products into cache so selection/rendering works quickly later
// We don't eagerly render them until a category is chosen, but caching helps find items for the Selected list.
// Initialize app: load products cache, restore saved selection, render selected list
(async function initApp() {
  await loadProducts();
  loadSelectedFromStorage();
  renderSelectedProducts();

  // wire clear button
  const clearBtn = document.getElementById("clearSelections");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearSelectedFromStorage();
    });
    // initial disabled state
    clearBtn.disabled = selectedProductIds.size === 0;
  }
})();
