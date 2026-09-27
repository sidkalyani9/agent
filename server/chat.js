import {
  HttpError,
  confirmProposal,
  createProposal,
  dismissProposal,
  getPantry,
  latestPending,
  listOffices,
  listOperations,
  resolveOffice,
  snapshotForChat,
} from "./service.js";
import { addDays, projectRunOut, todayInIndia } from "./calc.js";

const MODEL = () =>
  process.env.TOKENROUTER_MODEL ||
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const API_KEY = () => process.env.TOKENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || "";
const COMPLETIONS = "https://api.tokenrouter.com/v1/chat/completions";

const tools = [
  {
    type: "function",
    function: {
      name: "list_offices",
      description: "Offices this person can open.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pantry",
      description: "Live pantry figures for one office and month, including burn rate, on-hand, expected date, and the next-month forecast. Use this for any number. Never invent spend, on-hand, burn rate, forecast, or dates.",
      parameters: {
        type: "object",
        properties: {
          office: { type: "string" },
          month: { type: "string", description: "YYYY-MM. Omit for the current India month." },
        },
        required: ["office"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_activity",
      description: "Who changed this office's pantry, and when.",
      parameters: {
        type: "object",
        properties: { office: { type: "string" } },
        required: ["office"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_product",
      description: "Prepare a new pantry product. It is not saved until the person confirms.",
      parameters: {
        type: "object",
        properties: { office: { type: "string" }, name: { type: "string" } },
        required: ["office", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_purchase",
      description: "Prepare a purchase line. It is not saved until the person confirms. You cannot attach a receipt.",
      parameters: {
        type: "object",
        properties: {
          office: { type: "string" },
          product: { type: "string" },
          date: { type: "string" },
          packs: { type: "integer" },
          pricePerPack: { type: "number" },
        },
        required: ["office", "product", "packs", "pricePerPack"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_count",
      description: "Prepare a shelf count. It is not saved until the person confirms.",
      parameters: {
        type: "object",
        properties: {
          office: { type: "string" },
          product: { type: "string" },
          date: { type: "string" },
          packs: { type: "integer" },
        },
        required: ["office", "product", "packs"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_delete",
      description: "Prepare deletion of one product, one purchase, or one shelf count. Nothing is deleted until the person says yes.",
      parameters: {
        type: "object",
        properties: {
          office: { type: "string" },
          product: { type: "string" },
          target: { type: "string", enum: ["product", "purchase", "count"] },
          date: { type: "string", description: "YYYY-MM-DD, when deleting one purchase or count." },
          packs: { type: "integer" },
        },
        required: ["office", "product", "target"],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(db, person) {
  const snap = snapshotForChat(db, person);
  return `You are the pantry assistant inside Intuitive's Accounts and Inventory dashboard.
The signed-in person is ${person.displayName} <${person.email}>, ${snap.role}.
Today in India is ${todayInIndia()}.
Offices and live products:
${snap.lines.join("\n")}

Rules:
- You only discuss this pantry: offices, products, purchases, counts, spend, burn rate, stock on hand, and the expected date.
- If the person asks about anything else, including the weather, news, jokes, or general knowledge, say you only answer pantry questions. Do not answer the other topic.
- Follow-up questions stay in this conversation. If they say "it" or "that", use the product and office from the earlier turns, then call get_pantry again before you state a number.
- Answer only from tool results. If the office or product is ambiguous, ask which one.
- Next month's forecast is the forecast field. It is a calculation from the burn rate and that month's effective days. Quote the on-hand figure and the expected date when they ask what is left or when it runs out. Do not invent another projection, and do not say a model produced it.
- Money is Indian rupees. Dates are India dates, YYYY-MM-DD.
- propose_product, propose_purchase, propose_count, and propose_delete only prepare a card. Never say a record was saved or deleted unless a tool result says so.
- A delete is not done in the reply. The reply must say what will be deleted and ask the person to say yes.
- You cannot hide, restore, rename, correct, change a role, change weekend weight, or remove a receipt on its own. If asked, say that is not available.
- ${snap.canWriteSomewhere ? "This person may prepare pantry writes and deletes for the offices they manage." : "This person can look, and cannot prepare a write or a delete. Do not call propose tools."}
- Keep the reply short.`;
}

function isYes(text) {
  return /^(yes|yeah|yep|confirm|confirmed|do it|go ahead|okay|ok|sure|haan)\.?!?$/i.test(text.trim());
}

function isNo(text) {
  return /^(no|nope|cancel|stop|don't|do not)\.?!?$/i.test(text.trim());
}

function runTool(db, person, name, args) {
  try {
    if (name === "list_offices") return { offices: listOffices(db, person) };
    if (name === "get_pantry") {
      const office = resolveOffice(db, person, args.office);
      return getPantry(db, person, office.id, args.month, { series: false });
    }
    if (name === "list_activity") {
      const office = resolveOffice(db, person, args.office);
      return { activity: listOperations(db, person, office.id) };
    }
    if (name === "propose_product") return createProposal(db, person, "create_product", args);
    if (name === "propose_purchase") return createProposal(db, person, "add_purchase", args);
    if (name === "propose_count") return createProposal(db, person, "add_count", args);
    if (name === "propose_delete") {
      const target = String(args.target || "product");
      const action = target === "purchase" ? "delete_purchase" : target === "count" ? "delete_count" : "delete_product";
      return createProposal(db, person, action, args);
    }
    return { error: "That action is not available. The assistant cannot hide, restore, or correct." };
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "That could not be prepared.";
    return { error: message };
  }
}

export function scopeReply(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(hide|restore|unhide)\b/.test(lower) || /^\s*(please\s+)?hide\b/.test(lower)) {
    return "The assistant cannot hide or restore a record.";
  }
  if (/\b(rename|correct|weekend weight|change (a |the )?role)\b/.test(lower)) {
    return "The assistant cannot rename, correct, or change a role.";
  }
  if (
    /\b(delete|remove|erase|wipe|destroy|drop)\b/.test(lower) &&
    /\b(everything|all products|all records|database|every product|the office|this office)\b/.test(lower)
  ) {
    return "The assistant cannot delete an office or every record at once. Name one pantry item.";
  }
  if (/\breceipt\b/.test(lower) && /\b(delete|remove|erase)\b/.test(lower)) {
    return "The assistant cannot remove a receipt on its own.";
  }
  const aboutStock = /\b(coffee|milk|sugar|tea|sticks|pack|stock|burn|purchase|count|spend|on hand|run out|reorder|receipt|pantry)\b/.test(lower);
  const elsewhere = /\b(weather|rain|snow|joke|poem|lyrics|bitcoin|crypto|football|cricket|movie|recipe|president|capital of)\b/.test(lower);
  if (elsewhere && !aboutStock) {
    return "I only answer questions about this pantry: stock on hand, purchases, counts, spend, burn rate, and when a product is expected to run out.";
  }
  return "";
}

function toolsFor(canWrite) {
  return canWrite ? tools : tools.filter((tool) => !tool.function.name.startsWith("propose_"));
}

function safeText(text, proposals) {
  const cleaned = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  if (proposals.some((item) => String(item.action || "").startsWith("delete_"))) {
    const summary = proposals.map((item) => String(item.summary || "").replace(/\.$/, "")).join(" ");
    return `${summary} will be deleted. Say yes and I'll do it.`;
  }
  if (proposals.length) {
    const claimed = /saved|recorded|i'?ve added|i have added|done\.|already entered/i.test(cleaned);
    const summary = proposals.map((item) => item.summary).join(" ");
    if (!cleaned || claimed) return `${summary} This is not saved yet. Confirm the card and it will be entered.`;
    return cleaned;
  }
  return cleaned || "I could not read a reply from the model. Ask again, or use the pantry screen.";
}

function visible(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function replyText(message) {
  const parts = [];
  const content = message?.content;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part?.type !== "reasoning") parts.push(part?.text || part?.content || "");
    }
  }
  for (const detail of message?.reasoning_details || []) {
    if (detail?.type === "reasoning.text") continue;
    parts.push(detail?.text || detail?.summary || "");
  }
  const direct = visible(parts.join("\n"));
  if (direct) return direct;
  const reasoning = visible(message?.reasoning || message?.reasoning_content);
  const sentences = reasoning.split(/(?<=[.?!])\s+/).filter((line) => /\d|pack|₹/.test(line) && !/^okay\b/i.test(line));
  return sentences.slice(-2).join(" ");
}

const READ = /\b(left|on hand|run out|runs out|running out|how much|how many|when|spend|spent|burn|due|forecast|expected)\b/i;
const PRODUCT_NAMES = ["coffee", "milk", "sugar", "tea", "sticks"];

function namedProducts(text) {
  const lower = String(text || "").toLowerCase();
  return PRODUCT_NAMES.filter((name) => lower.includes(name));
}

function namedOffice(offices, text) {
  const lower = String(text || "").toLowerCase();
  return offices.find((office) => lower.includes(office.name.toLowerCase())) || null;
}

function indiaLong(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

function rupee(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value || 0));
}

function monthTitle(month) {
  const [year, mon] = String(month || "").split("-").map(Number);
  if (!year || !mon) return month;
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, mon - 1, 1)),
  );
}

function closedWorkingDays(text) {
  const patterns = [
    /(\d+)\s+more\s+working\s+days/i,
    /shut\s+for\s+(\d+)/i,
    /closed?\s+for\s+(\d+)/i,
    /(\d+)\s+extra\s+(?:leave|leaves|working\s+days|holidays)/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function describeProduct(officeName, product, month, question) {
  const wantsSpend = /\b(spend|spent|price|cost)\b/i.test(question);
  const wantsStock = /\b(left|on hand|how much|how many|run out|runs out|when|burn|due|expected|forecast)\b/i.test(question) || !wantsSpend;
  const lines = [];
  if (wantsStock) {
    lines.push(`${product.name} at ${officeName} has ${product.onHand} packs on hand.`);
    if (product.burnRatePerEffectiveDay) {
      lines.push(`The burn rate is ${product.burnRatePerEffectiveDay} packs per effective day.`);
    }
    if (product.expectedDate) {
      const closed = closedWorkingDays(question);
      if (closed > 0) {
        const adjusted = projectRunOut({
          today: product.today,
          onHand: product.onHand,
          burn: product.burnRatePerEffectiveDay,
          reorderLevel: product.reorderLevel,
          weekendWeight: product.weekendWeight,
          closedWeekdays: closed,
        });
        lines.push(
          `With the office shut for ${closed} more working days, it is expected to run out on ${indiaLong(adjusted.expectedDate)}. The date on the pantry screen stays ${indiaLong(product.expectedDate)}.`,
        );
      } else {
        lines.push(`It is expected to run out on ${indiaLong(product.expectedDate)}.`);
      }
    } else if (product.message) lines.push(product.message);
  }
  if (wantsSpend) {
    lines.push(`${officeName} has spent ${rupee(product.spend)} on ${product.name} in ${monthTitle(month)}.`);
  }
  return lines.join(" ");
}

export function factualReply(db, person, text, history = []) {
  if (!READ.test(text)) return "";
  const offices = listOffices(db, person);
  const earlier = history.map((item) => item.content || "").join("\n");
  const office = namedOffice(offices, text) || (offices.length === 1 ? offices[0] : namedOffice(offices, earlier));
  const products = namedProducts(text);
  const fromHistory = products.length ? products : namedProducts(earlier).slice(-1);
  if (!office) return "Which office should I use?";
  const wantsSpend = /\b(spend|spent|price|cost)\b/i.test(text);
  const wantsStock = /\b(left|on hand|how much|how many|run out|runs out|when|burn|due|expected|forecast)\b/i.test(text);
  if (!fromHistory.length && wantsStock && !wantsSpend) return "Which product should I use?";
  let pantry;
  try {
    pantry = getPantry(db, person, office.id, undefined, { series: false });
  } catch (error) {
    return error instanceof HttpError ? error.message : "";
  }
  if (!fromHistory.length && wantsSpend) {
    return `${office.name} has spent ${rupee(pantry.spend)} in ${monthTitle(pantry.month)}.`;
  }
  const lines = fromHistory.map((name) => {
    const product = pantry.products.find((item) => item.name.toLowerCase() === name && !item.deletedAt);
    return product
      ? describeProduct(
          office.name,
          { ...product, today: pantry.today, weekendWeight: pantry.settings.weekendWeight },
          pantry.month,
          text,
        )
      : `${name} is not on the ${office.name} pantry.`;
  });
  return lines.filter(Boolean).join(" ");
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function isDeleteRequest(text) {
  const lower = String(text || "").toLowerCase();
  if (/^\s*(please\s+)?(do not|don't|dont|no)\b/.test(lower)) return false;
  if (/\b(hide|restore|unhide|rename|correct)\b/.test(lower)) return false;
  if (/\breceipt\b/.test(lower)) return false;
  if (/\b(everything|all products|all records|database|every product|the office|this office)\b/.test(lower)) return false;
  return /\b(delete|remove|erase)\b/.test(lower) || /\btake\b[\s\S]{0,40}\boff\b/.test(lower);
}

function namedDate(text, today) {
  const raw = String(text || "");
  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\btoday\b/i.test(raw)) return today;
  if (/\byesterday\b/i.test(raw)) return addDays(today, -1);
  const lower = raw.toLowerCase();
  let month = 0;
  for (let index = 0; index < MONTHS.length; index += 1) {
    const name = MONTHS[index];
    const short = name.slice(0, 3);
    if (new RegExp(`\\b${name}\\b|\\b${short}t?\\b`).test(lower)) {
      month = index + 1;
      break;
    }
  }
  if (!month) return "";
  const year = Number((lower.match(/\b(20\d{2})\b/) || [])[1] || today.slice(0, 4));
  const name = MONTHS[month - 1];
  const short = name.slice(0, 3);
  const dayMatch =
    lower.match(new RegExp(`\\b(\\d{1,2})\\s+${name}\\b`)) ||
    lower.match(new RegExp(`\\b(\\d{1,2})\\s+${short}t?\\b`)) ||
    lower.match(new RegExp(`\\b${name}\\s+(\\d{1,2})\\b`)) ||
    lower.match(new RegExp(`\\b${short}t?\\s+(\\d{1,2})\\b`));
  const day = Number(dayMatch?.[1] || 0);
  if (day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function namedPacks(text) {
  const match = String(text || "").match(/\b(\d+)\s+packs?\b/i);
  return match ? Number(match[1]) : null;
}

function deletionKind(text) {
  const wantsPurchase = /\bpurchases?\b|\bbought\b/i.test(text);
  const wantsCount = /\bcounts?\b|\bcounted\b|\bshelf count\b/i.test(text);
  if (wantsPurchase && wantsCount) return "both";
  if (wantsPurchase) return "purchase";
  if (wantsCount) return "count";
  return "product";
}

export function deleteReply(db, person, text) {
  if (!isDeleteRequest(text)) return null;
  if (!snapshotForChat(db, person).canWriteSomewhere) {
    return { reply: "You can look at the pantry. You cannot delete an item.", proposals: [], saved: false };
  }
  try {
    const offices = listOffices(db, person);
    const named = namedOffice(offices, text);
    if (!named && offices.length !== 1) {
      return { reply: "Which office should I use?", proposals: [], saved: false };
    }
    const office = named || offices[0];
    const pantry = getPantry(db, person, office.id, undefined, { series: false });
    const names = pantry.products.filter((product) => !product.deletedAt).map((product) => product.name);
    const hits = names.filter((name) => text.toLowerCase().includes(name.toLowerCase()));
    if (hits.length !== 1) {
      return {
        reply: hits.length
          ? `I can delete one item at a time. Which one: ${hits.join(" or ")}?`
          : `Which product should I delete? ${names.join(", ")}.`,
        proposals: [],
        saved: false,
      };
    }
    const kind = deletionKind(text);
    if (kind === "both") {
      return { reply: "Should I delete a purchase or a shelf count?", proposals: [], saved: false };
    }
    const payload = { office: office.name, product: hits[0] };
    let action = "delete_product";
    if (kind !== "product") {
      action = kind === "purchase" ? "delete_purchase" : "delete_count";
      const date = namedDate(text, pantry.today);
      const packs = namedPacks(text);
      if (date) payload.date = date;
      if (packs != null) payload.packs = packs;
    }
    const proposal = createProposal(db, person, action, payload);
    return {
      reply: `${String(proposal.summary).replace(/\.$/, "")} will be deleted. Say yes and I'll do it.`,
      proposals: [presentProposal(proposal)],
      saved: false,
    };
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "That could not be prepared.";
    return { reply: message, proposals: [], saved: false };
  }
}

async function reveal(text, emit) {
  const value = String(text || "");
  if (!value) return;
  let cursor = 0;
  while (cursor < value.length) {
    let next = Math.min(value.length, cursor + 32);
    if (next < value.length) {
      const space = value.lastIndexOf(" ", next);
      if (space > cursor + 8) next = space + 1;
    }
    emit(value.slice(cursor, next));
    cursor = next;
    if (cursor < value.length) await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

function streamVisible(content) {
  return String(content || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
}

function appendToolCall(calls, deltaCall) {
  const index = Number.isInteger(deltaCall.index) ? deltaCall.index : 0;
  if (!calls[index]) calls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
  const target = calls[index];
  if (deltaCall.id) target.id = deltaCall.id;
  if (deltaCall.type) target.type = deltaCall.type;
  if (deltaCall.function?.name) target.function.name += deltaCall.function.name;
  if (deltaCall.function?.arguments) target.function.arguments += deltaCall.function.arguments;
}

async function readModelStream(response, onDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const message = { content: "", reasoning: "", tool_calls: [] };
  let shown = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta || {};
      if (typeof delta.content === "string") message.content += delta.content;
      const reasoning = delta.reasoning_content || delta.reasoning || "";
      if (typeof reasoning === "string") message.reasoning += reasoning;
      for (const call of delta.tool_calls || []) appendToolCall(message.tool_calls, call);
      const next = streamVisible(message.content);
      if (next.startsWith(shown) && next.length > shown.length && onDelta) {
        onDelta(next.slice(shown.length));
        shown = next;
      }
    }
  }
  message.tool_calls = message.tool_calls.filter((call) => call.function?.name);
  return message;
}

async function complete(messages, canWrite, onDelta) {
  const response = await fetch(COMPLETIONS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL(),
      temperature: 0.2,
      max_tokens: 1200,
      messages,
      tools: toolsFor(canWrite),
      tool_choice: "auto",
      ...(onDelta ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    console.error("assistant upstream", response.status);
    throw new HttpError(502, "The assistant could not reply. Try again in a moment.");
  }
  const type = response.headers.get("content-type") || "";
  if (onDelta && type.includes("text/event-stream")) return readModelStream(response, onDelta);
  const payload = await response.json().catch(() => ({}));
  return payload.choices?.[0]?.message || {};
}

export async function converse(db, person, history, message, hooks = {}) {
  const text = String(message || "").trim();
  if (!text) throw new HttpError(422, "Write a message first.");
  if (text.length > 2000) throw new HttpError(422, "Keep a message under 2000 characters.");
  const onDelta = typeof hooks.onDelta === "function" ? hooks.onDelta : null;
  const onReplace = typeof hooks.onReplace === "function" ? hooks.onReplace : null;
  let streamed = "";
  const emit = (piece) => {
    if (!piece) return;
    streamed += piece;
    if (onDelta) onDelta(piece);
  };
  async function deliver(payload) {
    if (onDelta && payload?.reply && streamed !== payload.reply) {
      if (!streamed) await reveal(payload.reply, emit);
      else if (onReplace) onReplace(payload.reply);
    }
    return payload;
  }

  const pending = latestPending(db, person.id);
  if (pending.length && isNo(text)) {
    for (const item of pending) dismissProposal(db, person, item.id);
    return deliver({ reply: "Left unsaved.", proposals: [], saved: false });
  }
  if (pending.length === 1 && isYes(text)) {
    const saved = confirmProposal(db, person, pending[0].id);
    const lead = String(saved.action || "").startsWith("delete_") ? "Deleted." : "Saved.";
    return deliver({ reply: `${lead} ${saved.summary}`, proposals: [], saved: true });
  }
  if (pending.length > 1 && isYes(text)) {
    return deliver({
      reply: "More than one card is waiting. Confirm the one you want on screen.",
      proposals: pending.map(presentProposal),
      saved: false,
    });
  }
  const blocked = scopeReply(text);
  if (blocked) return deliver({ reply: blocked, proposals: [], saved: false });
  const deletion = deleteReply(db, person, text);
  if (deletion) return deliver(deletion);
  const known = factualReply(db, person, text, history);
  if (known) return deliver({ reply: known, proposals: [], saved: false });
  if (!API_KEY()) {
    return deliver({
      reply: "The assistant is not switched on yet. Recording on the pantry screen still works.",
      proposals: [],
      saved: false,
    });
  }

  const canWrite = snapshotForChat(db, person).canWriteSomewhere;
  const messages = [
    { role: "system", content: systemPrompt(db, person) },
    ...history.slice(-10).map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 2000) })),
    { role: "user", content: text },
  ];
  const proposals = [];
  let reply = "";
  let lastPantry = null;
  for (let step = 0; step < 3; step += 1) {
    const assistant = await complete(messages, canWrite, onDelta ? emit : null);
    const calls = assistant.tool_calls || [];
    messages.push({
      role: "assistant",
      content: typeof assistant.content === "string" ? assistant.content : replyText(assistant),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    if (!calls.length) {
      reply = safeText(replyText(assistant), proposals);
      if (reply.startsWith("I could not read a reply") && lastPantry) {
        reply = factualReply(db, person, text, history) || reply;
      }
      break;
    }
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const result = runTool(db, person, call.function?.name, args);
      if (call.function?.name === "get_pantry" && result && !result.error) lastPantry = result;
      if (result?.proposalId) proposals.push(presentProposal(result));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    reply = safeText("", proposals);
  }
  return deliver({ reply, proposals, saved: false });
}

function presentProposal(row) {
  return {
    id: row.proposalId || row.id,
    summary: row.summary,
    action: row.action,
  };
}

export function chatConfigured() {
  return Boolean(API_KEY());
}

export function modelName() {
  return MODEL();
}
