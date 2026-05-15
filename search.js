const fetch = require("node-fetch");

const NEEDS_SEARCH_KEYWORDS = [
  "sekarang", "terbaru", "terkini", "hari ini", "minggu ini", "bulan ini",
  "harga", "berita", "news", "update", "rilis", "cuaca", "weather",
  "live", "score", "skor", "jadwal", "trending", "viral", "2025", "2026"
];

async function searchWeb(query) {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, gl: "id", hl: "id", num: 5 }),
    });
    const data = await res.json();
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet || "";
    const results = data.organic?.slice(0, 5).map(r => `- ${r.title}: ${r.snippet}`).join("\n") || "";
    return answerBox ? `${answerBox}\n\n${results}` : results;
  } catch (e) {
    console.error("Search error:", e);
    return "";
  }
}

function needsSearch(text) {
  const lower = text.toLowerCase();
  return NEEDS_SEARCH_KEYWORDS.some(k => lower.includes(k));
}

module.exports = { searchWeb, needsSearch };
