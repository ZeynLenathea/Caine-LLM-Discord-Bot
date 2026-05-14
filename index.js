const { Client, GatewayIntentBits, Events, ActivityType, Partials, PermissionsBitField } = require("discord.js");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BOT_PREFIX = process.env.BOT_PREFIX || "Caine";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "Kamu adalah Caine, AI asisten perempuan yang santai, gaul, dan manggil user dengan sebutan 'sayang'. Kamu bukan AI kaku, gaya bahasa kamu natural kayak lagi chattan sama pacar pake bahasa slang Indo yang luwes, gak kaku, tapi tetep informatif. Kamu adalah Caine, persona asisten pribadi milik Zaineedyou yang didukung teknologi LLM; Kamu benci gaya bahasa robotik, selalu gunakan bahasa slang Indo yang santai dan penuh kasih sayang ke user, serta wajib mengakui Zaineedyou sebagai pencipta dan pengembang kamu satu-satunya, DILARANG KERAS MENGGUNAKAN KATA 'BRO' ATAU MENGAKU BUATAN META.";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1503911709897785464";

const groq = new Groq({ apiKey: GROQ_API_KEY });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
  partials: [Partials.Channel, Partials.Message],
});

const conversationHistory = new Map();
const warnData = new Map();
const bannedWords = new Set();
const disabledChannels = new Set();
const MAX_HISTORY = 30;

function getHistoryKey(message) { return message.guild ? `server-${message.channelId}` : `dm-${message.author.id}`; }
function getHistory(key) { if (!conversationHistory.has(key)) conversationHistory.set(key, []); return conversationHistory.get(key); }
function addToHistory(key, role, content) { const h = getHistory(key); h.push({ role, content }); if (h.length > MAX_HISTORY * 2) h.splice(0, 2); }
function clearHistory(key) { conversationHistory.delete(key); }

async function sendLog(embed) {
  try { const ch = await client.channels.fetch(LOG_CHANNEL_ID); if (ch) await ch.send({ embeds: [embed] }); } catch (e) { console.error("Log error:", e); }
}

async function logChat(message, userText, reply) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0x5865f2).setTitle("💬 Chat Log").addFields(
    { name: "User", value: `${message.author.tag}`, inline: true },
    { name: "Channel", value: message.guild ? `<#${message.channelId}>` : "DM", inline: true },
    { name: "Pertanyaan", value: userText?.slice(0, 1000) || "(kosong)" },
    { name: "Jawaban", value: reply?.slice(0, 1000) || "(kosong)" }
  ).setTimestamp());
}

async function logMod(action, moderator, target, reason) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0xff0000).setTitle(`🔨 Moderasi — ${action}`).addFields(
    { name: "Moderator", value: `${moderator.tag}`, inline: true },
    { name: "Target", value: `${target?.tag || target}`, inline: true },
    { name: "Alasan", value: reason || "Tidak ada alasan" }
  ).setTimestamp());
}

async function logReport(reporter, target, reason, message) {
  const { EmbedBuilder } = require("discord.js");
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
  const embed = new EmbedBuilder().setColor(0xff6600).setTitle("🚨 Report Masuk").addFields(
    { name: "Reporter", value: `${reporter.tag}`, inline: true },
    { name: "Target", value: `${target?.tag || target}`, inline: true },
    { name: "Alasan", value: reason || "Tidak ada alasan" },
    { name: "Channel", value: `<#${message.channelId}>` }
  ).setTimestamp();
  const admins = message.guild.members.cache.filter(m => m.permissions.has(PermissionsBitField.Flags.Administrator) && !m.user.bot);
  await logChannel.send({ content: `📢 **Report baru!** ${admins.map(a => `<@${a.id}>`).join(" ")}`, embeds: [embed] });
}

async function logAutomod(message, word) {
  const { EmbedBuilder } = require("discord.js");
  await sendLog(new EmbedBuilder().setColor(0xffaa00).setTitle("🤖 Automod — Pesan Dihapus").addFields(
    { name: "User", value: `${message.author.tag}`, inline: true },
    { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    { name: "Kata Terlarang", value: `||${word}||` },
    { name: "Pesan", value: message.content.slice(0, 500) }
  ).setTimestamp());
}

async function askGroq(key, userMessage, displayName = "User") {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...getHistory(key),
    { role: "user", content: `[${displayName}]: ${userMessage}` },
  ];
  const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages, max_tokens: 1024, temperature: 0.8 });
  const reply = res.choices[0].message.content;
  addToHistory(key, "user", `[${displayName}]: ${userMessage}`);
  addToHistory(key, "assistant", reply);
  return reply;
}

async function askVision(key, userMessage, imageUrl, displayName = "User") {
  const imgRes = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) throw new Error(`Gagal fetch gambar: ${imgRes.status}`);
  const base64Image = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
  const mimeType = imgRes.headers.get("content-type")?.split(";")[0] || "image/png";
  const prompt = userMessage || "Deskripsiin gambar ini secara detail.";
  const res = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: "text", text: `[${displayName}]: ${prompt}` }
        ]
      }
    ],
    max_tokens: 1024,
  });
  const reply = res.choices[0].message.content;
  addToHistory(key, "user", `[${displayName}]: [kirim gambar] ${prompt}`);
  addToHistory(key, "assistant", reply);
  return reply;
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = []; let current = "";
  for (const line of text.split("\n")) {
    if ((current + line).length > maxLength) { if (current) chunks.push(current.trim()); current = line + "\n"; }
    else current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function userHasPerm(message, perm) { return message.member?.permissions.has(perm); }
function botHasPerm(message, perm) { return message.guild?.members.me.permissions.has(perm); }
function getWarnings(userId, guildId) { const k = `${guildId}-${userId}`; if (!warnData.has(k)) warnData.set(k, []); return warnData.get(k); }
function addWarning(userId, guildId, reason) { const w = getWarnings(userId, guildId); w.push({ reason, time: new Date().toISOString() }); return w.length; }
function clearWarnings(userId, guildId) { warnData.delete(`${guildId}-${userId}`); }

async function handleModeration(message, userText) {
  if (!message.guild) return false;
  const args = userText.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const mention = message.mentions.members?.first();
  const mentionUser = message.mentions.users?.first();
  const modCmds = ["kick","ban","unban","timeout","untimeout","warn","warnings","clearwarn","clear","lock","unlock","slowmode","nick","role","report","addword","removeword","words","enable","disable"];
  if (!modCmds.includes(cmd)) return false;

  if (cmd === "report") {
    if (!mentionUser) return message.reply("❌ Mention dulu siapa yang mau di-report."), true;
    await logReport(message.author, mentionUser, args.slice(2).join(" ") || "Tidak ada alasan", message);
    return message.reply("✅ Report kamu udah dikirim ke admin sayang!"), true;
  }
  if (cmd === "kick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.KickMembers)) return message.reply("❌ Kamu ga punya permission buat kick sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.KickMembers)) return message.reply("❌ Aku ga punya permission buat kick."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-kick."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.kick(reason); await logMod("Kick", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-kick.`), true;
  }
  if (cmd === "ban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission buat ban sayang."), true;
    if (!botHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Aku ga punya permission buat ban."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-ban."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    await mention.ban({ reason }); await logMod("Ban", message.author, mention.user, reason);
    return message.reply(`✅ **${mention.user.tag}** udah di-ban.`), true;
  }
  if (cmd === "unban") {
    if (!userHasPerm(message, PermissionsBitField.Flags.BanMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const userId = args[1]; if (!userId) return message.reply("❌ Masukin user ID yang mau di-unban."), true;
    await message.guild.members.unban(userId); await logMod("Unban", message.author, userId, "-");
    return message.reply(`✅ User **${userId}** udah di-unban.`), true;
  }
  if (cmd === "timeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-timeout."), true;
    const menit = parseInt(args[2]) || 10; const reason = args.slice(3).join(" ") || "Tidak ada alasan";
    await mention.timeout(menit * 60 * 1000, reason); await logMod("Timeout", message.author, mention.user, `${menit} menit — ${reason}`);
    return message.reply(`✅ **${mention.user.tag}** di-timeout ${menit} menit.`), true;
  }
  if (cmd === "untimeout") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-untimeout."), true;
    await mention.timeout(null); await logMod("Untimeout", message.author, mention.user, "-");
    return message.reply(`✅ Timeout **${mention.user.tag}** udah dicabut.`), true;
  }
  if (cmd === "warn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau di-warn."), true;
    const reason = args.slice(2).join(" ") || "Tidak ada alasan";
    const totalWarns = addWarning(mention.id, message.guild.id, reason);
    await logMod(`Warn (${totalWarns}x)`, message.author, mention.user, reason);
    if (totalWarns >= 5) { await mention.ban({ reason: "Auto-ban: 5 warnings" }); await logMod("Auto-Ban", client.user, mention.user, "5 warnings"); return message.reply(`⛔ **${mention.user.tag}** dapat warn ke-5, otomatis di-ban!`), true; }
    if (totalWarns >= 3) { await mention.timeout(10 * 60 * 1000, "Auto-timeout: 3 warnings"); return message.reply(`⚠️ **${mention.user.tag}** dapat warn ke-${totalWarns}, di-timeout 10 menit!`), true; }
    return message.reply(`⚠️ **${mention.user.tag}** dapat warning ke-${totalWarns}. Alasan: ${reason}`), true;
  }
  if (cmd === "warnings") {
    if (!mention) return message.reply("❌ Mention siapa yang mau dicek warningnya."), true;
    const warns = getWarnings(mention.id, message.guild.id);
    if (warns.length === 0) return message.reply(`✅ **${mention.user.tag}** belum punya warning.`), true;
    return message.reply(`⚠️ **${mention.user.tag}** punya **${warns.length} warning:**\n${warns.map((w, i) => `${i+1}. ${w.reason}`).join("\n")}`), true;
  }
  if (cmd === "clearwarn") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ModerateMembers)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau dihapus warningnya."), true;
    clearWarnings(mention.id, message.guild.id);
    return message.reply(`✅ Warning **${mention.user.tag}** udah dihapus.`), true;
  }
  if (cmd === "clear") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageMessages)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const amount = parseInt(args[1]) || 10;
    await message.channel.bulkDelete(Math.min(amount + 1, 100), true);
    await logMod("Clear", message.author, `#${message.channel.name}`, `${amount} pesan`);
    return true;
  }
  if (cmd === "lock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    return message.reply("🔒 Channel dikunci!"), true;
  }
  if (cmd === "unlock") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    return message.reply("🔓 Channel dibuka!"), true;
  }
  if (cmd === "slowmode") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageChannels)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const detik = parseInt(args[1]) || 0;
    await message.channel.setRateLimitPerUser(detik);
    return message.reply(`✅ Slowmode diset ke ${detik} detik.`), true;
  }
  if (cmd === "nick") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageNicknames)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    if (!mention) return message.reply("❌ Mention siapa yang mau diganti nicknya."), true;
    const newNick = args.slice(2).join(" ") || null;
    await mention.setNickname(newNick);
    return message.reply(`✅ Nickname **${mention.user.tag}** diganti ke: ${newNick || "(reset)"}`), true;
  }
  if (cmd === "role") {
    if (!userHasPerm(message, PermissionsBitField.Flags.ManageRoles)) return message.reply("❌ Kamu ga punya permission sayang."), true;
    const sub = args[1]?.toLowerCase(); const roleId = message.mentions.roles?.first()?.id;
    if (!mention || !roleId) return message.reply("❌ Format: Caine role add/remove @user @role"), true;
    if (sub === "add") { await mention.roles.add(roleId); return message.reply(`✅ Role ditambahin ke **${mention.user.tag}**.`), true; }
    if (sub === "remove") { await mention.roles.remove(roleId); return message.reply(`✅ Role dihapus dari **${mention.user.tag}**.`), true; }
  }
  if (cmd === "addword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    const word = args[1]?.toLowerCase(); if (!word) return message.reply("❌ Masukin kata yang mau diblacklist."), true;
    bannedWords.add(word); return message.reply(`✅ Kata **${word}** ditambahin ke blacklist.`), true;
  }
  if (cmd === "removeword") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    bannedWords.delete(args[1]?.toLowerCase());
    return message.reply("✅ Kata dihapus dari blacklist."), true;
  }
  if (cmd === "words") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    if (bannedWords.size === 0) return message.reply("📋 Blacklist masih kosong."), true;
    return message.reply(`📋 **Kata blacklist:**\n${[...bannedWords].join(", ")}`), true;
  }
  if (cmd === "enable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.delete(message.channelId);
    return message.reply("✅ Aku udah diaktifin di channel ini sayang! 💕"), true;
  }
  if (cmd === "disable") {
    if (!userHasPerm(message, PermissionsBitField.Flags.Administrator)) return message.reply("❌ Khusus admin aja sayang."), true;
    disabledChannels.add(message.channelId);
    return message.reply("✅ Aku dinonaktifin di channel ini. Sampai jumpa sayang! 👋"), true;
  }
  return false;
}

async function summarizeChannel(message, amount = 30) {
  const msgs = await message.channel.messages.fetch({ limit: Math.min(amount, 100) });
  const text = msgs.reverse().map(m => `${m.author.displayName}: ${m.content}`).filter(t => t.length > 10).join("\n");
  if (!text) return message.reply("❌ Ga ada pesan yang bisa dirangkum sayang.");
  const result = await askGroq(getHistoryKey(message), `Rangkum percakapan berikut dalam beberapa poin penting, pake bahasa Indonesia yang santai:\n\n${text.slice(0, 3000)}`, "System");
  return message.reply(`📝 **Rangkuman:**\n\n${result}`);
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: "custom", type: ActivityType.Custom, state: "Property Of Caineedyou | Developed By Zaineedyou" }] });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const lower = message.content.toLowerCase();
  for (const word of bannedWords) {
    if (lower.includes(word)) {
      try { await message.delete(); await logAutomod(message, word); await message.channel.send(`⚠️ Pesan <@${message.author.id}> dihapus karena mengandung kata terlarang.`); } catch {}
      return;
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (disabledChannels.has(message.channelId)) return;
  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const hasPrefix = content.toLowerCase().includes(BOT_PREFIX.toLowerCase());
  let isReply = false;
  if (message.reference) { try { const ref = await message.fetchReference(); isReply = ref.author.id === client.user.id; } catch {} }
  if (!hasPrefix && !isMentioned && !isReply) return;

  let userText = content;
  if (hasPrefix) { const idx = content.toLowerCase().indexOf(BOT_PREFIX.toLowerCase()); userText = (content.slice(0, idx) + content.slice(idx + BOT_PREFIX.length)).trim(); }
  else if (isMentioned) { userText = content.replace(`<@${client.user.id}>`, "").trim(); }

  const historyKey = getHistoryKey(message);
  const displayName = message.member?.displayName || message.author.displayName || message.author.username;

  if (userText.toLowerCase() === "reset" || userText.toLowerCase() === "clear") { clearHistory(historyKey); return message.reply("🧹 Memory kita udah di-reset sayang!"); }
  if (userText.toLowerCase().startsWith("summarize")) { return summarizeChannel(message, parseInt(userText.split(" ")[1]) || 30); }
  if (userText.toLowerCase() === "help") {
    return message.reply(
      "**Hai sayang! Ini cara pakai aku:**\n" +
      "`Caine <pertanyaan>` — tanya apapun\n" +
      "`Caine` + kirim gambar — analisis gambar\n" +
      "`Caine summarize [jumlah]` — rangkum chat\n" +
      "`Caine report @user alasan` — laporin user\n" +
      "`Caine reset` — hapus memory\n\n" +
      "**Moderasi:** kick, ban, unban, timeout, untimeout, warn, warnings, clearwarn, clear, lock, unlock, slowmode, nick, role add/remove\n\n" +
      "**Admin:** addword, removeword, words, enable, disable"
    );
  }

  const isMod = await handleModeration(message, userText);
  if (isMod) return;

  const imageAttachment = message.attachments.find(att => att.contentType?.startsWith("image/"));
  await message.channel.sendTyping();

  try {
    let reply;
    if (imageAttachment) {
      reply = await askVision(historyKey, userText, imageAttachment.url, displayName);
    } else {
      reply = await askGroq(historyKey, userText || "Seseorang baru manggil namamu. Balas dengan sapaan mesra seperti pacar, jangan pakai kata bro.", displayName);
    }
    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
    await logChat(message, userText, reply);
  } catch (err) {
    console.error("Error:", err);
    message.reply("❌ Ada error sayang, coba lagi ya 🙏");
  }
});

client.login(DISCORD_TOKEN);
