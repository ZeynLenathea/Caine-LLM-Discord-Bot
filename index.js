const { Client, GatewayIntentBits, Events, ActivityType, Partials, PermissionsBitField } = require("discord.js");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BOT_PREFIX = process.env.BOT_PREFIX || "Caine";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "Kamu adalah AI asisten bernama Caine yang nyantai dan gaul. Jawab pake bahasa Indonesia slang yang natural, kayak ngobrol sama pacar. Tetep informatif dan tepat tapi ga kaku. Jangan pake bahasa formal atau kaku.";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1503911709897785464";

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

// ============================================================
// STORAGE
// ============================================================
const conversationHistory = new Map();
const warnData = new Map();
const bannedWords = new Set();
const disabledChannels = new Set();
const MAX_HISTORY = 30;

function getHistoryKey(message) {
  return message.guild ? `server-${message.channelId}` : `dm-${message.author.id}`;
}

function getHistory(key) {
  if (!conversationHistory.has(key)) conversationHistory.set(key, []);
  return conversationHistory.get(key);
}

function addToHistory(key, role, content) {
  const history = getHistory(key);
  history.push({ role, content });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
}

function clearHistory(key) {
  conversationHistory.delete(key);
}

// ============================================================
// LOGGING
// ============================================================
async function sendLog(embed) {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Log error:", e);
  }
}

async function logChat(message, userText, reply) {
  const { EmbedBuilder } = require("discord.js");
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("💬 Chat Log")
    .addFields(
      { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
      { name: "Channel", value: message.guild ? `<#${message.channelId}>` : "DM", inline: true },
      { name: "Pertanyaan", value: userText?.slice(0, 1000) || "(kosong)" },
      { name: "Jawaban", value: reply?.slice(0, 1000) || "(kosong)" }
    )
    .setTimestamp();
  await sendLog(embed);
}

async function logMod(action, moderator, target, reason) {
  const { EmbedBuilder } = require("discord.js");
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(`🔨 Moderasi — ${action}`)
    .addFields(
      { name: "Moderator", value: `${moderator.tag}`, inline: true },
      { name: "Target", value: `${target?.tag || target}`, inline: true },
      { name: "Alasan", value: reason || "Tidak ada alasan" }
    )
    .setTimestamp();
  await sendLog(embed);
}

async function logReport(reporter, target, reason, message) {
  const { EmbedBuilder } = require("discord.js");
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setColor(0xff6600)
    .setTitle("🚨 Report Masuk")
    .addFields(
      { name: "Reporter", value: `${reporter.tag}`, inline: true },
      { name: "Target", value: `${target?.tag || target}`, inline: true },
      { name: "Alasan", value: reason || "Tidak ada alasan" },
      { name: "Channel", value: `<#${message.channelId}>` }
    )
    .setTimestamp();

  // Tag semua admin
  const guild = message.guild;
  const admins = guild.members.cache.filter(m =>
    m.permissions.has(PermissionsBitField.Flags.Administrator) && !m.user.bot
  );
  const adminMentions = admins.map(a => `<@${a.id}>`).join(" ");
  await logChannel.send({ content: `📢 **Report baru!** ${adminMentions}`, embeds: [embed] });
}

async function logAutomod(message, word) {
  const { EmbedBuilder } = require("discord.js");
  const embed = new EmbedBuilder()
    .setColor(0xffaa00)
    .setTitle("🤖 Automod — Pesan Dihapus")
    .addFields(
      { name: "User", value: `${message.author.tag}`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Kata Terlarang", value: `||${word}||` },
      { name: "Pesan", value: message.content.slice(0, 500) }
    )
    .setTimestamp();
  await sendLog(embed);
}

// ============================================================
// AI
// ============================================================
async function askGroq(key, userMessage) {
  const history = getHistory(key);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 1024,
    temperature: 0.8,
  });
  const reply = response.choices[0].message.content;
  addToHistory(key, "user", userMessage);
  addToHistory(key, "assistant", reply);
  return reply;
}

async function askGemini(key, userMessage, imageUrl) {
  const imageResponse = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!imageResponse.ok) throw new Error(`Gagal fetch gambar: ${imageResponse.status}`);

  const arrayBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = imageResponse.headers.get("content-type")?.split(";")[0] || "image/png";

  const prompt = userMessage || "Deskripsiin gambar ini secara detail.";

  const response = await groq.chat.completions.create({
    model: "llama-3.2-11b-vision-preview",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: "text", text: prompt }
        ]
      }
    ],
    max_tokens: 1024,
  });

  const reply = response.choices[0].message.content;
  addToHistory(key, "user", `[User kirim gambar] ${prompt}`);
  addToHistory(key, "assistant", reply);
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

// ============================================================
// PERMISSION CHECK
// ============================================================
function userHasPerm(message, perm) {
  return message.member?.permissions.has(perm);
}

function botHasPerm(message, perm) {
  return message.guild?.members.me.permissions.has(perm);
}

// ============================================================
// WARNING SYSTEM
// ============================================================
function getWarnings(userId, guildId) {
  const key = `${guildId}-${userId}`;
  if (!warnData.has(key)) warnData.set(key, []);
  return warnData.get(key);
}

function addWarning(userId, guildId, reason) {
  const warns = getWarnings(userId, guildId);
  warns.push({ reason, time: new Date().toISOString() });
  return warns.length;
}

function clearWarnings(userId, guildId) {
  warnData.delete(`${guildId}-${userId}`);
}

// ============================================================
// MODERATION HANDLER
// ============================================================
async function handleModeration(message, userText) {
  if (!message.guild) return false;

  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const mention = message.mentions.members?.first();
  const mentionUser = message.mentions.users?.first();

  const modCommands = [
    "kick", "ban", "unban", "timeout", "untimeout",
    "warn", "warnings", "clearwarn",
    "clear", "lock", "unlock", "slowmode",
    "nick", "role", "report",
    "addword", "removeword", "words",
    "enable", "disable"
  ];

  if (!modCommands.includes(cmd)) return false;

  // REPORT — bisa semua user
  if (cmd === "report") {
    if (!mentionUser) return message.reply("❌ Mention dulu siapa yang mau di-report. Contoh: `Caine report @user alasan`"), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await logReport(message.author, mentionUser, reason, message);
    return message.reply("✅ Report kamu udah dikirim ke admin sayang!"), true;
  }

  // KICK
  if (cmd === "kick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.KickMembers))
      return message.reply("❌ Kamu ga punya permission buat kick sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.KickMembers))
      return message.reply("❌ Aku ga punya permission buat kick."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-kick. Contoh: `Caine kick @user alasan`"), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.kick(reason);
    await logMod("Kick", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-kick. Alasan: ${reason}`), true;
  }

  // BAN
  if (cmd === "ban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers))
      return message.reply("❌ Kamu ga punya permission buat ban sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.BanMembers))
      return message.reply("❌ Aku ga punya permission buat ban."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-ban. Contoh: `Caine ban @user alasan`"), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.ban({ reason });
    await logMod("Ban", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-ban. Alasan: ${reason}`), true;
  }

  // UNBAN
  if (cmd === "unban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers))
      return message.reply("❌ Kamu ga punya permission buat unban sayang."), true;
    const userId = args[1];
    if (!userId) return message.reply("❌ Masukin user ID yang mau di-unban."), true;
    await message.guild.members.unban(userId);
    await logMod("Unban", message.author, userId, "-");
    return message.reply(`✅ User **${userId}** udah di-unban.`), true;
  }

  // TIMEOUT
  if (cmd === "timeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers))
      return message.reply("❌ Kamu ga punya permission buat timeout sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-timeout. Contoh: `Caine timeout @user 10 alasan`"), true;
    const menit = parseInt(args[2]) || 10;
    const reason = args.slice(3).join(" ") || "Tidak ada alasan";
    await mention.timeout(menit * 60 * 1000, reason);
    await logMod("Timeout", message.author, mention.user, `${menit} menit — ${reason}`);
    return message.reply(`✅ **${mention.user.tag}** di-timeout ${menit} menit.`), true;
  }

  // UNTIMEOUT
  if (cmd === "untimeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-untimeout."), true;
    await mention.timeout(null);
    await logMod("Untimeout", message.author, mention.user, "-");
    return message.reply(`✅ Timeout **${mention.user.tag}** udah dicabut.`), true;
  }

  // WARN
  if (cmd === "warn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers))
      return message.reply("❌ Kamu ga punya permission buat warn sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-warn."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    const totalWarns = addWarning(mention.id, message.guild.id, reason);
    await logMod(`Warn (${totalWarns}x)`, message.author, mention.user, reason);

    if (totalWarns >= 5) {
      await mention.ban({ reason: "Auto-ban: 5 warnings" });
      await logMod("Auto-Ban (5 warns)", client.user, mention.user, "Akumulasi warning");
      return message.reply(`⛔ **${mention.user.tag}** udah dapat warn ke-5, otomatis di-ban!`), true;
    }
    if (totalWarns >= 3) {
      await mention.timeout(10 * 60 * 1000, "Auto-timeout: 3 warnings");
      return message.reply(`⚠️ **${mention.user.tag}** dapat warn ke-${totalWarns}, otomatis di-timeout 10 menit!`), true;
    }
    return message.reply(`⚠️ **${mention.user.tag}** dapat warning ke-${totalWarns}. Alasan: ${reason}`), true;
  }

  // WARNINGS
  if (cmd === "warnings") {
    if (!mention) return message.reply("❌ Mention siapa yang mau dicek warningnya."), true;
    const warns = getWarnings(mention.id, message.guild.id);
    if (warns.length === 0) return message.reply(`✅ **${mention.user.tag}** belum punya warning.`), true;
    const list = warns.map((w, i) => `${i + 1}. ${w.reason} (${w.time})`).join("\n");
    return message.reply(`⚠️ **${mention.user.tag}** punya **${warns.length} warning:**\n${list}`), true;
  }

  // CLEARWARN
  if (cmd === "clearwarn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau dihapus warningnya."), true;
    clearWarnings(mention.id, message.guild.id);
    return message.reply(`✅ Semua warning **${mention.user.tag}** udah dihapus.`), true;
  }

  // CLEAR
  if (cmd === "clear") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageMessages))
      return message.reply("❌ Kamu ga punya permission buat clear sayang."), true;
    const amount = parseInt(args[1]) || 10;
    await message.channel.bulkDelete(Math.min(amount + 1, 100), true);
    await logMod("Clear Messages", message.author, `#${message.channel.name}`, `${amount} pesan`);
    return true;
  }

  // LOCK
  if (cmd === "lock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    return message.reply("🔒 Channel dikunci!"), true;
  }

  // UNLOCK
  if (cmd === "unlock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    return message.reply("🔓 Channel dibuka!"), true;
  }

  // SLOWMODE
  if (cmd === "slowmode") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    const detik = parseInt(args[1]) || 0;
    await message.channel.setRateLimitPerUser(detik);
    return message.reply(`✅ Slowmode diset ke ${detik} detik.`), true;
  }

  // NICK
  if (cmd === "nick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageNicknames))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau diganti nicknya."), true;
    const newNick = args.slice(2).join(" ") || null;
    await mention.setNickname(newNick);
    return message.reply(`✅ Nickname **${mention.user.tag}** udah diganti ke: ${newNick || "(reset)"}`), true;
  }

  // ROLE
  if (cmd === "role") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageRoles))
      return message.reply("❌ Kamu ga punya permission sayang."), true;
    const sub = args[1]?.toLowerCase();
    const roleId = message.mentions.roles?.first()?.id;
    if (!mention || !roleId) return message.reply("❌ Format: `Caine role add/remove @user @role`"), true;
    if (sub === "add") {
      await mention.roles.add(roleId);
      return message.reply(`✅ Role berhasil ditambahin ke **${mention.user.tag}**.`), true;
    }
    if (sub === "remove") {
      await mention.roles.remove(roleId);
      return message.reply(`✅ Role berhasil dihapus dari **${mention.user.tag}**.`), true;
    }
  }

  // ADDWORD
  if (cmd === "addword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator))
      return message.reply("❌ Khusus admin aja sayang."), true;
    const word = args[1]?.toLowerCase();
    if (!word) return message.reply("❌ Masukin kata yang mau diblacklist."), true;
    bannedWords.add(word);
    return message.reply(`✅ Kata **${word}** udah ditambahin ke blacklist.`), true;
  }

  // REMOVEWORD
  if (cmd === "removeword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator))
      return message.reply("❌ Khusus admin aja sayang."), true;
    const word = args[1]?.toLowerCase();
    bannedWords.delete(word);
    return message.reply(`✅ Kata **${word}** udah dihapus dari blacklist.`), true;
  }

  // WORDS
  if (cmd === "words") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator))
      return message.reply("❌ Khusus admin aja sayang."), true;
    if (bannedWords.size === 0) return message.reply("📋 Blacklist masih kosong."), true;
    return message.reply(`📋 **Kata blacklist:**\n${[...bannedWords].join(", ")}`), true;
  }

  // ENABLE / DISABLE
  if (cmd === "enable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator))
      return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.delete(message.channelId);
    return message.reply("✅ Aku udah diaktifin di channel ini sayang! 💕"), true;
  }

  if (cmd === "disable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator))
      return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.add(message.channelId);
    return message.reply("✅ Aku dinonaktifin di channel ini. Sampai jumpa sayang! 👋"), true;
  }

  return false;
}

// ============================================================
// SUMMARIZE
// ============================================================
async function summarizeChannel(message, amount = 30) {
  const messages = await message.channel.messages.fetch({ limit: Math.min(amount, 100) });
  const text = messages.reverse().map(m => `${m.author.username}: ${m.content}`).filter(t => t.length > 10).join("\n");
  if (!text) return message.reply("❌ Ga ada pesan yang bisa dirangkum sayang.");
  const prompt = `Rangkum percakapan berikut dalam beberapa poin penting, pake bahasa Indonesia yang santai:\n\n${text.slice(0, 3000)}`;
  const result = await askGroq(getHistoryKey(message), prompt);
  return message.reply(`📝 **Rangkuman percakapan:**\n\n${result}`);
}

// ============================================================
// READY
// ============================================================
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  c.user.setPresence({
    activities: [{
      name: "custom",
      type: ActivityType.Custom,
      state: "Property Of Caineedyou | Developed By Zaineedyou"
    }],
  });
});

// ============================================================
// AUTOMOD
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const lowerContent = message.content.toLowerCase();
  for (const word of bannedWords) {
    if (lowerContent.includes(word)) {
      try {
        await message.delete();
        await logAutomod(message, word);
        await message.channel.send(`⚠️ Pesan <@${message.author.id}> dihapus karena mengandung kata terlarang.`);
      } catch {}
      return;
    }
  }
});

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (disabledChannels.has(message.channelId)) return;

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

  const historyKey = getHistoryKey(message);

  // RESET
  if (userText.toLowerCase() === "reset" || userText.toLowerCase() === "clear") {
    clearHistory(historyKey);
    return message.reply("🧹 Memory kita udah di-reset sayang!");
  }

  // SUMMARIZE
  if (userText.toLowerCase().startsWith("summarize")) {
    const amount = parseInt(userText.split(" ")[1]) || 30;
    return summarizeChannel(message, amount);
  }

  // HELP
  if (userText.toLowerCase() === "help") {
    return message.reply(
      `**💕 Hai sayang! Ini cara pakai aku:**\n` +
      `\`Caine <pertanyaan>\` — tanya apapun\n` +
      `\`Caine\` + kirim gambar — analisis gambar\n` +
      `\`Caine summarize [jumlah]\` — rangkum chat\n` +
      `\`Caine report @user alasan\` — laporin user\n` +
      `\`Caine reset\` — hapus memory\n\n` +
      `**Moderasi:** kick, ban, unban, timeout, untimeout, warn, warnings, clearwarn, clear, lock, unlock, slowmode, nick, role add/remove\n\n` +
      `**Admin:** addword, removeword, words, enable, disable`
    );
  }

  // MODERATION
  const isMod = await handleModeration(message, userText);
  if (isMod) return;

  // IMAGE
  const imageAttachment = message.attachments.find(att => att.contentType?.startsWith("image/"));

  await message.channel.sendTyping();

  try {
    let reply;
    if (imageAttachment) {
      reply = await askGemini(historyKey, userText, imageAttachment.url);
    } else {
      const prompt = userText || "balas dengan gaya kamu sendiri seolah kamu baru dipanggil namamu, seperti 'Halo sayang, kenapa nih manggil aku?'";
      reply = await askGroq(historyKey, prompt);
    }

    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
    await logChat(message, userText, reply);

  } catch (err) {
    console.error("Error:", err);
      message.reply("❌ Ada error sayang, coba lagi ya 🙏");
    }
  }
});

client.login(DISCORD_TOKEN);
     
