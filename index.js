const { Client, GatewayIntentBits, Events, ActivityType } = require("discord.js");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BOT_PREFIX = process.env.BOT_PREFIX || "!ai";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "Kamu adalah AI asisten bernama Caine yang nyantai dan gaul. Jawab pake bahasa Indonesia slang yang natural, kayak ngobrol sama pacar. Tetep informatif dan tepat tapi ga kaku. Jangan pake bahasa formal atau kaku.";

const groq = new Groq({ apiKey: GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const conversationHistory = new Map();
const MAX_HISTORY = 10;

function getHistory(userId) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
}

function clearHistory(userId) {
  conversationHistory.delete(userId);
}

async function askGroq(userId, userMessage) {
  const history = getHistory(userId);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 1024,
    temperature: 0.7,
  });
  const reply = response.choices[0].message.content;
  addToHistory(userId, "user", userMessage);
  addToHistory(userId, "assistant", reply);
  return reply;
}

async function askGemini(userId, userMessage, imageUrl) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const imageResponse = await fetch(imageUrl);
  const imageBuffer = await imageResponse.buffer();
  const base64Image = imageBuffer.toString("base64");
  const mimeType = imageResponse.headers.get("content-type") || "image/png";
  const prompt = userMessage || "Describe this image in detail.";
  const result = await model.generateContent([
    { inlineData: { data: base64Image, mimeType } },
    prompt,
  ]);
  const reply = result.response.text();
  addToHistory(userId, "user", `[User sent an image] ${prompt}`);
  addToHistory(userId, "assistant", reply);
  return reply;
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot online sebagai ${c.user.tag}`);
  c.user.setPresence({
    activities: [{ 
      name: "custom", 
      type: ActivityType.Custom, 
      state: "Property Of Caineedyou | Developed By Zaineedyou" 
    }],
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const hasPrefix = content.toLowerCase().includes(BOT_PREFIX.toLowerCase());
  const isReply = message.reference && 
  (await message.fetchReference()).author.id === client.user.id;

if (!hasPrefix && !isMentioned && !isReply) return;

  let userText = content;
  if (hasPrefix) userText = content.slice(BOT_PREFIX.length).trim();
  else if (isMentioned) userText = content.replace(`<@${client.user.id}>`, "").trim();

  if (userText.toLowerCase() === "reset" || userText.toLowerCase() === "clear") {
    clearHistory(message.author.id);
    return message.reply("🧹 Memory Kamu udah di-reset!");
  }

  if (userText.toLowerCase() === "help") {
    return message.reply(
      `**🤖 Cara Pakai:**\n` +
      `\`${BOT_PREFIX} <pertanyaan>\` — tanya apapun\n` +
      `\`${BOT_PREFIX}\` + kirim gambar — analisis gambar\n` +
      `\`${BOT_PREFIX} reset\` — hapus memory\n\n` +
      `**Model:** Groq llama-3.3-70b (teks) • Gemini 1.5 Flash (gambar)`
    );
  }

  const imageAttachment = message.attachments.find((att) =>
    att.contentType?.startsWith("image/")
  );

  await message.channel.sendTyping();

  try {
    let reply;
    if (imageAttachment) {
      reply = await askGemini(message.author.id, userText, imageAttachment.url);
      reply = `🖼️ *[Gemini Vision]*\n\n${reply}`;
    } else {
      if (!userText) return message.reply("Iya? kenapa, Sayang?");
      reply = await askGroq(message.author.id, userText);
    }
    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
  } catch (err) {
    console.error("Error:", err);
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(userText);
      const fallback = result.response.text();
      const chunks = splitMessage(`⚡ *[Gemini Fallback]*\n\n${fallback}`);
      for (const chunk of chunks) await message.reply(chunk);
    } catch {
      message.reply("❌ Ada error Sayang, coba lagi ya.");
    }
  }
});

client.login(DISCORD_TOKEN);
