const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const axios = require("axios"); // For Yandex API
const fetch = require("node-fetch"); // For Gemini API
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- FIREBASE INITIALIZATION ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        let jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (jsonStr.includes('\\n')) {
             jsonStr = jsonStr.replace(/\\n/g, '\n');
        }
        serviceAccount = JSON.parse(jsonStr);
        console.log("Successfully parsed FIREBASE_SERVICE_ACCOUNT from env");
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT:", e.message);
    }
} else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    // Fallback: Construct from individual vars
    try {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
        serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID || "linguamentor-d432c",
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
        };
        console.log("Successfully constructed serviceAccount from granular env vars");
    } catch (e) {
        console.error("Failed to construct serviceAccount from vars:", e.message);
    }
} else {
    try {
        // Local fallback (won't work on Render if file not in git)
        serviceAccount = require("./linguamentor-d432c-firebase-adminsdk-fbsvc-ce9238d805.json");
    } catch (e) {
        console.warn("Local service account file not found.");
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.error("Firebase credentials not found! App will fail.");
}
// -----------------------------

const db = admin.firestore();

// --- YANDEX SPEECHKIT CONFIG ---
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_API_KEY = process.env.YANDEX_SPEECHKIT_API_KEY;

// --- GEMINI & OPENROUTER CONFIG ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// --- ENDPOINTS ---

// 1. Text-to-Speech (Yandex)
app.post("/speak", async (req, res) => {
    try {
        const { text, language = "en-US", speed = "1.0", voice = "oksana" } = req.body.data || {};

        if (!text) {
             return res.status(400).json({ error: "Text is required" });
        }

        console.log(`TTS Request: "${text}" (${language})`);

        if (!YANDEX_FOLDER_ID || !YANDEX_API_KEY) {
            console.error("Yandex credentials missing");
            return res.status(500).json({ error: "Yandex credentials missing on server" });
        }

        const params = new URLSearchParams();
        params.append("text", text);
        params.append("lang", language === "ru" ? "ru-RU" : "en-US");
        params.append("voice", voice);
        params.append("folderId", YANDEX_FOLDER_ID);
        params.append("speed", speed);
        params.append("format", "mp3");

        const response = await axios.post(
            "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize",
            params,
            {
                headers: {
                    Authorization: \`Api-Key ${YANDEX_API_KEY}\`,
                },
                responseType: "arraybuffer",
            }
        );

        const audioBase64 = Buffer.from(response.data, "binary").toString("base64");
        res.json({ data: { audioContent: audioBase64 } });

    } catch (error) {
        console.error("Yandex TTS Error:", error.response?.data || error.message);
        
        let errorMsg = error.message;
        if (error.response && error.response.data) {
             try {
                 const buffer = Buffer.from(error.response.data);
                 errorMsg = buffer.toString('utf8');
             } catch (e) {
                 // ignore
             }
        }
        
        res.status(500).json({ error: \`Yandex TTS Failed: ${errorMsg}\` });
    }
});

// 2. Chat (OpenRouter / Gemini)
app.post("/chat", async (req, res) => {
    try {
        const { message, history = [], systemPrompt } = req.body.data || {};
        
        if (!message) {
             return res.status(400).json({ error: "Message is required" });
        }

        const apiKey = OPENROUTER_API_KEY || GEMINI_API_KEY;
        const apiUrl = OPENROUTER_API_KEY 
            ? "https://openrouter.ai/api/v1/chat/completions"
            : "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" + GEMINI_API_KEY;

        let requestBody;
        let headers = {
            "Content-Type": "application/json"
        };

        if (OPENROUTER_API_KEY) {
             headers["Authorization"] = \`Bearer ${OPENROUTER_API_KEY}\`;
             const messages = [];
             if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
             messages.push(...history);
             messages.push({ role: "user", content: message });

             requestBody = JSON.stringify({
                 model: "google/gemini-2.0-flash-exp:free",
                 messages: messages
             });
        } else {
             // Gemini Direct
             const contents = [];
             if (history.length > 0) {
                 // Convert history format if needed
             }
             contents.push({ role: "user", parts: [{ text: message }] });
             requestBody = JSON.stringify({ contents });
        }

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: requestBody
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error?.message || "API Error");
        }

        let reply = "";
        if (OPENROUTER_API_KEY) {
            reply = data.choices[0].message.content;
        } else {
            reply = data.candidates[0].content.parts[0].text;
        }

        res.json({ data: { reply } });

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(\`Server is running on port ${PORT}\`);
});

exports.api = functions.https.onRequest(app);
