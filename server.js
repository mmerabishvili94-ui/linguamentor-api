const express = require('express');
const admin = require('firebase-admin');
const OpenAI = require("openai");
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Initialize Express
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Firebase with Service Account
const serviceAccount = require("./linguamentor-d432c-firebase-adminsdk-fbsvc-fc3417fa8e.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Config
const OWNER_TELEGRAM_ID = 102436862;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
    console.error("ERROR: OPENROUTER_API_KEY not set!");
    process.exit(1);
}

// Initialize OpenRouter (OpenAI-compatible API)
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "https://linguamentor-d432c.web.app",
        "X-Title": "LinguaMentor"
    }
});

const AI_MODEL = "google/gemini-2.0-flash-001";

// --- Routes ---

app.post('/chat', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const userMessage = requestData.message;

    console.log(`[Chat] Request from ${userId}: ${userMessage}`);

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const userDoc = await db.collection('users').doc(String(userId)).get();
        const userData = userDoc.exists ? userDoc.data() : {
            level: 'Intermediate',
            goals: 'General English',
            weakPoints: []
        };

        const historySnapshot = await db.collection(`dialogs/${userId}/messages`)
            .orderBy('createdAt', 'desc')
            .limit(20)
            .get();

        const distinctHistory = [];
        historySnapshot.forEach(doc => {
            distinctHistory.unshift(doc.data());
        });

        const systemContent = `You are a personal long-term English tutor.
      
Student profile:
- Native language: Russian
- Level: ${userData.level}
- Goals: ${userData.goals}
- Weak points: ${(userData.weakPoints || []).join(', ')}

Rules:
1. Main language is English. Conduct the lesson primarily in English.
2. IF the student asks a question in Russian or says they don't understand without English context, explain clearly in Russian.
3. IF the student asks to "speak Russian", feel free to switch to Russian for explanations.
4. Correct mistakes gently. For complex grammar errors, provide a brief explanation in Russian.
5. Behave like a patient, real private tutor. Not a rigid robot.
6. Always encourage the student to try speaking English again after an explanation.`;

        // Convert history to OpenAI format
        const messages = [
            { role: 'system', content: systemContent },
            ...distinctHistory.map(msg => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.text
            })),
            { role: 'user', content: userMessage }
        ];

        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: messages,
        });

        const aiResponse = completion.choices[0].message.content;

        await db.collection(`dialogs/${userId}/messages`).add({
            role: 'user',
            text: userMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await db.collection(`dialogs/${userId}/messages`).add({
            role: 'assistant',
            text: aiResponse,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ response: aiResponse });

    } catch (error) {
        console.error("Error in chat:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/summarizeLesson', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const historySnapshot = await db.collection(`dialogs/${userId}/messages`)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const distinctHistory = [];
        historySnapshot.forEach(doc => {
            distinctHistory.unshift(doc.data());
        });

        if (distinctHistory.length === 0) {
            return res.json({ message: "No messages to summarize" });
        }

        const chatText = distinctHistory.map(msg =>
            `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.text}`
        ).join('\n');

        const prompt = `Analyze this English lesson and output JSON only:
${chatText}

Format: {"topic":"...","mistakes":["..."],"newVocabulary":["..."],"recommendations":"..."}`;

        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" }
        });

        const summaryJson = JSON.parse(completion.choices[0].message.content);

        await db.collection(`lessons/${userId}/records`).add({
            ...summaryJson,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, summary: summaryJson });

    } catch (error) {
        console.error("Error in summary:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/getChatHistory', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const historySnapshot = await db.collection(`dialogs/${userId}/messages`)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const messages = [];
        historySnapshot.forEach(doc => {
            messages.unshift(doc.data());
        });

        res.json({ messages });
    } catch (error) {
        console.error("Error fetching history", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/translate', async (req, res) => {
    const requestData = req.body.data || req.body;
    const text = requestData.text;
    const targetLang = requestData.targetLang || 'ru';

    if (!text) {
        return res.status(400).json({ error: "No text provided" });
    }

    try {
        const prompt = `You are a professional translator. Translate the following text to ${targetLang === 'ru' ? 'Russian' : 'English'}. Preserve all markdown formatting. Just return the translation, nothing else.
Text:
${text}`;

        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
        });

        const translatedText = completion.choices[0].message.content;
        res.json({ translation: translatedText });

    } catch (error) {
        console.error("Error translating:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using OpenRouter API with model: ${AI_MODEL}`);
});
