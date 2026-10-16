// =====================================================================
// VOICE: speech-to-text (listen) and text-to-speech (speak)
// Uses the browser's built-in Web Speech API (works in Chrome on
// Android and laptops; listening needs internet).
// =====================================================================

const Voice = (() => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canListen = !!Recognition;
  const canSpeak = "speechSynthesis" in window;
  let voices = [];

  function loadVoices() { if (canSpeak) voices = speechSynthesis.getVoices(); }
  if (canSpeak) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

  const voiceFor = lang => voices.find(v => v.lang.replace("_", "-").toLowerCase().startsWith(lang));
  const hasKannadaVoice = () => !!voiceFor("kn");

  // Speak a message. lang = "en" or "kn". If no Kannada voice is installed,
  // it speaks the English version instead (and the screen still shows Kannada).
  function say(en, kn, lang = "en") {
    if (!canSpeak) return;
    speechSynthesis.cancel();
    const useKn = lang === "kn" && kn && hasKannadaVoice();
    const u = new SpeechSynthesisUtterance(useKn ? kn : en);
    const v = useKn ? voiceFor("kn") : (voiceFor("en-in") || voiceFor("en"));
    if (v) u.voice = v;
    u.lang = useKn ? "kn-IN" : "en-IN";
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }

  // Listen once. onText(text, isFinal) is called as words arrive.
  function listen(lang, onText, onDone, onError) {
    if (!canListen) { onError("unsupported"); return null; }
    const rec = new Recognition();
    rec.lang = lang === "kn" ? "kn-IN" : "en-IN";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = e => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      finalText = text;
      onText(text, e.results[e.results.length - 1].isFinal);
    };
    rec.onerror = e => onError(e.error);
    rec.onend = () => onDone(finalText);
    rec.start();
    return rec;
  }

  // ---------- understand what the vendor said ----------
  const EN_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
                   eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
  const KN_NUM = { "ಒಂದು": 1, "ಎರಡು": 2, "ಮೂರು": 3, "ನಾಲ್ಕು": 4, "ಐದು": 5, "ಆರು": 6, "ಏಳು": 7, "ಎಂಟು": 8, "ಒಂಬತ್ತು": 9, "ಹತ್ತು": 10 };
  const KN_DIGITS = "೦೧೨೩೪೫೬೭೮೯";

  function findNumber(text) {
    const t = text.replace(/[೦-೯]/g, d => String(KN_DIGITS.indexOf(d)));
    const digits = t.match(/\d+/);
    if (digits) return parseInt(digits[0], 10);
    for (const [word, n] of Object.entries(KN_NUM)) if (t.includes(word)) return n;
    for (const word of t.toLowerCase().split(/[^a-z]+/)) if (EN_NUM[word]) return EN_NUM[word];
    return null;
  }

  // Returns { intent: "request" | "earnings" | "status" | "unknown", sacks }
  function understand(text) {
    const t = text.toLowerCase();
    if (/earn|money|rupee|how much|paid|ಗಳಿಕೆ|ಹಣ|ದುಡ್ಡು|ರೂಪಾಯಿ/.test(t)) return { intent: "earnings" };
    if (/status|where|when|coming|ಎಲ್ಲಿ|ಯಾವಾಗ|ಸ್ಥಿತಿ|ಬರುತ್ತ/.test(t)) return { intent: "status" };
    const n = findNumber(text);
    if (n || /pick|sack|bag|collect|shell|ಚೀಲ|ಪಿಕಪ್|ಚಿಪ್ಪು|ತೆಗೆದು/.test(t)) return { intent: "request", sacks: n };
    return { intent: "unknown" };
  }

  return { canListen, canSpeak, hasKannadaVoice, say, listen, understand };
})();
