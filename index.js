const { Client, GatewayIntentBits, Events, ActivityType, Partials, PermissionsBitField } = require("discord.js");
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message],
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

  const imageResponse = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!imageResponse.ok) throw new Error(`Gagal fetch gambar: ${imageResponse.status}`);

  const arrayBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = imageResponse.headers.get("content-type")?.split(";")[0] || "image/png";

  const prompt = userMessage || "Deskripsiin gambar ini secara detail.";
  const result = await model.generateContent([
    { inlineData: { data: base64Image, mimeType } },
    prompt,
  ]);
  const reply = result.response.text();
  addToHistory(userId, "user", `[User kirim gambar] ${prompt}`);
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

async function handleModeration(message, userText) {
  if (!message.guild) return false;

  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const mention = message.mentions.members?.first();
  const botMember = message.guild.members.me;

  const modCommands = ["kick", "ban", "timeout", "untimeout", "unban"];
  if (!modCommands.includes(cmd)) return false;

  if (cmd === "kick") {
    if (!botMember.permissions.has(PermissionsBitField.Flags.KickMembers))
      return message.reply("❌ Aku ga punya permission buat kick."), true;
    if (!mention) return message.reply("❌ Mention dulu siapa yang mau di-kick. Contoh: `Caine kick @user alasan`"), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.kick(reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-kick. Alasan: ${reason}`), true;
  }

  if (cmd === "ban") {
    if (!botMember.permissions.has(PermissionsBitField.Flags.BanMembers))
      return message.reply("❌ Aku ga punya permission buat ban."), true;
    if (!mention) return message.reply("❌ Mention dulu siapa yang mau di-ban. Contoh: `Caine ban @user alasan`"), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.ban({ reason });
    return message.reply(`✅ **${mention.user.tag}** udah di-ban. Alasan: ${reason}`), true;
  }

  if (cmd === "timeout") {
    if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers))
      return message.reply("❌ Aku ga punya permission buat timeout."), true;
    if (!mention) return message.reply("❌ Mention dulu siapa yang mau di-timeout. Contoh: `Caine timeout @user 10 alasan`"), true;
    const menit = parseInt(args[2]) || 10;
    const reason = args.slice(3).join(" ") || "Tidak ada alasan";
    await mention.timeout(menit * 60 * 1000, reason);
    return message.reply(`✅ **${mention.user.tag}** di-timeout ${menit} menit. Alasan: ${reason}`), true;
  }

  if (cmd === "untimeout") {
    if (!mention) return message.reply("❌ Mention dulu siapa yang mau di-untimeout."), true;
    await mention.timeout(null);
    return message.reply(`✅ Timeout **${mention.user.tag}** udah dicabut.`), true;
  }

  if (cmd === "unban") {
    const userId = args[1];
    if (!userId) return message.reply("❌ Masukin user ID yang mau di-unban."), true;
    await message.guild.members.unban(userId);
    return message.reply(`✅ User **${userId}** udah di-unban.`), true;
  }

  return false;
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

  let isReply = false;
  if (message.reference) {
    try {
      const ref = await message.fetchReference();
      isReply = ref.author.id === client.user.id;
    } catch {}
  }

  if (!hasPrefix && !isMentioned && !isReply) return;

  let userText = content;
  if (hasPrefix) {
    const idx = content.toLowerCase().indexOf(BOT_PREFIX.toLowerCase());
    userText = (content.slice(0, idx) + content.slice(idx + BOT_PREFIX.length)).trim();
  } else if (isMentioned) {
    userText = content.replace(`<@${client.user.id}>`, "").trim();
  }

  if (userText.toLowerCase() === "reset" || userText.toLowerCase() === "clear") {
    clearHistory(message.author.id);
    return message.reply("🧹 Memory Kamu udah di-reset!");
  }

  if (userText.toLowerCase() === "help") {
    return message.reply(
      `**🤖 Cara Pakai:**\n` +
      `\`${BOT_PREFIX} <pertanyaan>\` — tanya apapun\n` +
      `\`${BOT_PREFIX}\` + kirim gambar — analisis gambar\n` +
      `\`${BOT_PREFIX} kick/ban/timeout @user\` — moderasi\n` +
      `\`${BOT_PREFIX} reset\` — hapus memory\n\n` +
      `**Model:** Caine Local AI`
    );
  }

  const isMod = await handleModeration(message, userText);
  if (isMod) return;

  const imageAttachment = message.attachments.find((att) =>
    att.contentType?.startsWith("image/")
  );

  await message.channel.sendTyping();

  try {
    let reply;
    if (imageAttachment) {
      reply = await askGemini(message.author.id, userText, imageAttachment.url);
    } else {
      if (!userText) {
        reply = await askGroq(message.author.id, "Halo, ada yang manggil aku nih");
      } else {
        reply = await askGroq(message.author.id, userText);
      }
    }
    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
  } catch (err) {
    console.error("Error:", err);
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(userText || "Halo");
      const fallback = result.response.text();
      const chunks = splitMessage(fallback);
      for (const chunk of chunks) await message.reply(chunk);
    } catch {
      message.reply("❌ Ada error Sayang, coba lagi ya.");
    }
  }
});

client.login(DISCORD_TOKEN);
