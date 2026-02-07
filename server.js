const express = require('express');
const admin = require('firebase-admin');
const OpenAI = require("openai");
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Load data files
const vocabulary = require('./data/vocabulary.json');
const grammar = require('./data/grammar.json');

// Initialize Express
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Firebase with Service Account
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        let jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT;
        // Fix potential double-escaped newlines from some env var editors
        if (jsonStr.includes('\\n')) {
            jsonStr = jsonStr.replace(/\\n/g, '\n');
        }
        serviceAccount = JSON.parse(jsonStr);
        console.log("Successfully parsed FIREBASE_SERVICE_ACCOUNT from env");
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT:", e.message);
    }
} else {
    try {
        serviceAccount = require("./linguamentor-d432c-firebase-adminsdk-fbsvc-ce9238d805.json");
    } catch (e) {
        console.warn("Local service account file not found, taking no action.");
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.error("Firebase credentials not found!");
}

const db = admin.firestore();

// Config
const OWNER_TELEGRAM_ID = 102436862;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const YANDEX_SPEECHKIT_API_KEY = process.env.YANDEX_SPEECHKIT_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;

if (!OPENROUTER_API_KEY) {
    console.error("ERROR: OPENROUTER_API_KEY not set!");
    process.exit(1);
}

if (!YANDEX_SPEECHKIT_API_KEY) {
    console.warn("WARNING: YANDEX_SPEECHKIT_API_KEY not set! TTS will not work.");
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

// ===== UPDATE PROFILE =====
app.post('/updateProfile', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const profile = requestData.profile;

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        await db.collection('users').doc(String(userId)).set(profile, { merge: true });
        res.json({ success: true });
    } catch (error) {
        console.error("Error updating profile", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== CHAT =====
app.post('/chat', async (req, res) => {
    const requestData = req.body.data || req.body;
    const { userId, message: userMessage, mode, activeLesson: clientActiveLesson } = requestData;
    const language = requestData.language || 'en';
    const validLanguages = ['en', 'it'];

    if (!validLanguages.includes(language)) {
        return res.status(400).json({ error: "Invalid language" });
    }

    console.log(`[Chat] Request from ${userId}: ${userMessage}`);

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        console.warn(`Unauthorized access attempt from: ${userId}`);
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const userRef = db.collection('users').doc(String(userId));
        const userDoc = await userRef.get();

        // Update Active Lesson if changed (only in lesson mode)
        if (mode === 'lesson' && clientActiveLesson) {
            await userRef.set({ activeLesson: clientActiveLesson }, { merge: true });
        }

        const userData = userDoc.exists ? userDoc.data() : {
            level: 'Intermediate',
            goal: 'General English',
            style: 'Friendly tutor',
            activeLesson: 'lesson1'
        };

        const activeLesson = clientActiveLesson || userData.activeLesson || 'lesson1';

        // --- SYSTEM PROMPT GENERATION ---
        let systemInstructionText = "";

        const langName = language === 'it' ? 'Italian' : 'English';
        const tutorRole = language === 'it' ? 'Italian Tutor' : 'English Tutor';

        const baseProfile = `Student Profile:
- Level: ${userData.level} (${langName})
- Goal: ${userData.goal}
- Preferred Style: ${userData.style}
`;

        if (mode === 'conversation') {
            systemInstructionText = `You are an ${tutorRole}. Style: ${userData.style}.
${baseProfile}
Task: Chat naturally in ${langName}.
Rules:
1. Speak ${langName}.
2. If the user asks clearly "Translate this" or "What does X mean in Russian?", you MUST provide the translation/explanation in their native language, then switch back to ${langName}.
3. Correct only significant mistakes that hinder understanding.
4. Keep the flow natural.`;

        } else if (mode === 'lesson') {
            const lessonPrompts = {
                'lesson1': "TOPIC: Introduction & Basics. Teach how to introduce oneself.",
                'lesson2': "TOPIC: Present Tense. Habits, facts, daily routines.",
                'lesson3': "TOPIC: At the Restaurant. Ordering food, asking for the bill.",
                'lesson4': "TOPIC: Travel. Asking for directions, checking in at a hotel."
            };
            systemInstructionText = `You are teaching a structured ${langName} lesson.
${baseProfile}
Current Lesson: ${lessonPrompts[activeLesson] || "General Lesson"}
Rules:
1. Explain ONE concept or ask ONE question at a time.
2. No long lectures. Interactive step-by-step.
3. Give examples in ${langName} (with translation if beginner).
4. Correct every mistake strictly related to the topic.`;

        } else if (mode === 'fixme') {
            systemInstructionText = `You remain in 'Fix Me' mode.
${baseProfile}
Task: The user will send text (likely trying to write in ${langName}). You must:
1. Correct the text.
2. Explain the main error (briefly).
3. Suggest a more natural native alternative.
Output format:
"✅ Corrected: ..."
"💡 Explanation: ..."
"✨ Better way: ..."`;

        } else if (mode === 'vocab') {
            systemInstructionText = `You are a Vocabulary Helper for ${langName}.
${baseProfile}
Task: The user sends a word or phrase.
1. Define it.
2. Give 3 examples in context.
3. Show collocations.`;

        } else if (mode === 'grammar') {
            systemInstructionText = `You are a Grammar Coach for ${langName}.
${baseProfile}
Task: The user will ask a topic or send a sentence.
1. Explain the rule simply (suited for ${userData.level}).
2. Give 2 examples.
3. Ask the user to create a sentence using this rule to check understanding.`;
        }

        // Load History
        const collectionPath = language === 'en'
            ? `dialogs/${userId}/messages`
            : `dialogs/${userId}/messages_${language}`;

        const historySnapshot = await db.collection(collectionPath)
            .orderBy('createdAt', 'desc')
            .limit(20)
            .get();

        const distinctHistory = [];
        historySnapshot.forEach(doc => {
            distinctHistory.unshift(doc.data());
        });

        // Convert to OpenAI format
        const messages = [
            { role: 'system', content: systemInstructionText },
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

        // Save History
        await db.collection(collectionPath).add({
            role: 'user',
            text: userMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await db.collection(collectionPath).add({
            role: 'assistant',
            text: aiResponse,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ response: aiResponse });
    } catch (error) {
        console.error("Error processing chat request", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== SUMMARIZE LESSON =====
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

        const prompt = `Analyze the conversation and output JSON only.
History:
${chatText}

Format: { "topic": "...", "mistakes": [...], "newVocabulary": [...], "recommendations": "..." }`;

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

// ===== GET CHAT HISTORY =====
app.post('/getChatHistory', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const language = requestData.language || 'en';

    if (parseInt(userId) !== OWNER_TELEGRAM_ID && OWNER_TELEGRAM_ID !== 0) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const collectionPath = language === 'en'
            ? `dialogs/${userId}/messages`
            : `dialogs/${userId}/messages_${language}`;

        const historySnapshot = await db.collection(collectionPath)
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

// ===== SPEAK (Text-to-Speech via Yandex SpeechKit) =====
app.post('/speak', async (req, res) => {
    const requestData = req.body.data || req.body;
    const text = requestData.text;
    const language = requestData.language || 'en';

    if (!text) {
        return res.status(400).json({ error: "No text provided" });
    }

    if (!YANDEX_SPEECHKIT_API_KEY || !YANDEX_FOLDER_ID) {
        return res.status(500).json({ error: "Yandex SpeechKit not configured" });
    }

    try {
        // Select voice based on language
        // Yandex voices: https://yandex.cloud/en/docs/speechkit/tts/voices
        let voice, lang;

        switch (language) {
            case 'it':
                // Yandex doesn't have Italian, use English
                voice = 'john'; // English male voice
                lang = 'en-US';
                break;
            case 'ru':
                voice = 'filipp'; // Russian male voice
                lang = 'ru-RU';
                break;
            case 'en':
            default:
                voice = 'john'; // English male voice
                lang = 'en-US';
        }

        const authHeader = `Api-Key ${YANDEX_SPEECHKIT_API_KEY}`;
        console.log('[Yandex TTS]', {
            lang,
            voice,
            textLength: text.length,
            keyPrefix: YANDEX_SPEECHKIT_API_KEY ? YANDEX_SPEECHKIT_API_KEY.substring(0, 5) + '...' : 'NONE'
        });

        // Yandex SpeechKit API v1
        const params = new URLSearchParams({
            text: text,
            lang: lang,
            voice: voice,
            format: 'mp3',
            speed: '0.9',
            folderId: YANDEX_FOLDER_ID
        });

        const response = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
            method: 'POST',
            headers: {
                'Authorization': `Api-Key ${YANDEX_SPEECHKIT_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Yandex TTS Error:', response.status, errorText);
            throw new Error(`Yandex TTS returned ${response.status}: ${errorText}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());

        res.set('Content-Type', 'audio/mpeg');
        res.send(audioBuffer);

    } catch (error) {
        console.error("Yandex TTS Error", error);
        res.status(500).json({
            error: "Yandex TTS Failed: " + error.message,
            keyPrefix: YANDEX_SPEECHKIT_API_KEY ? YANDEX_SPEECHKIT_API_KEY.substring(0, 5) + '...' : 'NONE'
        });
    }
});

// ===== TRANSLATE =====
app.post('/translate', async (req, res) => {
    const requestData = req.body.data || req.body;
    const text = requestData.text;
    const targetLang = requestData.targetLang || 'ru';

    if (!text) {
        return res.status(400).json({ error: "No text provided" });
    }

    try {
        const prompt = `You are a professional translator. Translate the following text to ${targetLang === 'ru' ? 'Russian' : 'English'}. Preserve all markdown formatting (bold, italics, etc). Do not add any conversational filler, just the translation.
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

// ===== GET DAILY WORDS =====
app.post('/getDailyWords', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const language = requestData.language || 'en';

    if (!userId) {
        return res.status(400).json({ error: "No user ID" });
    }

    try {
        // 1. Fetch User's Word History
        const userWordsSnapshot = await db.collection(`users/${userId}/user_words_${language}`).get();
        const userWordsMap = new Map();
        const categories = {
            new: [],
            learning: [],
            weak: [],
            known: []
        };

        userWordsSnapshot.forEach(doc => {
            const data = doc.data();
            userWordsMap.set(data.word, data);
            if (data.status) {
                if (categories[data.status]) {
                    categories[data.status].push(data);
                } else {
                    categories.learning.push(data);
                }
            }
        });

        // --- TOPIC MODE LOGIC ---
        const topic = requestData.topic ? requestData.topic.toLowerCase() : null;
        if (topic) {
            const topicWords = vocabulary.filter(w => w.tags && w.tags.includes(topic));

            const now = new Date();
            const COOL_DOWN_HOURS = 20;
            const isCool = (timestamp) => {
                if (!timestamp) return true;
                const lastSeenDate = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
                const diffHours = (now - lastSeenDate) / (1000 * 60 * 60);
                return diffHours > COOL_DOWN_HOURS;
            };

            const topicNew = [];
            const topicReview = [];
            const topicReviewFallback = [];
            const topicKnownFallback = [];

            topicWords.forEach(w => {
                if (userWordsMap.has(w.word)) {
                    const userData = userWordsMap.get(w.word);

                    if (userData.status === 'known') {
                        topicKnownFallback.push(userData);
                        return;
                    }

                    if (userData.status === 'learning' && !isCool(userData.last_seen)) {
                        topicReviewFallback.push(userData);
                        return;
                    }

                    topicReview.push(userData);
                } else {
                    topicNew.push({ ...w, status: 'new', correct_streak: 0, wrong_count: 0 });
                }
            });

            const TARGET_COUNT = 8;
            let selected = [];
            const shuffle = (arr) => arr.sort(() => 0.5 - Math.random());

            selected.push(...shuffle([...topicNew]));

            if (selected.length < TARGET_COUNT) {
                const needed = TARGET_COUNT - selected.length;
                selected.push(...shuffle([...topicReview]).slice(0, needed));
            }

            if (selected.length < TARGET_COUNT) {
                const needed = TARGET_COUNT - selected.length;
                selected.push(...shuffle([...topicReviewFallback]).slice(0, needed));
            }

            if (selected.length < TARGET_COUNT) {
                const needed = TARGET_COUNT - selected.length;
                selected.push(...shuffle([...topicKnownFallback]).slice(0, needed));
            }

            selected = selected.slice(0, TARGET_COUNT);

            res.json({
                words: selected,
                stats: {
                    streak: (await db.collection('users').doc(String(userId)).get()).data()?.streak || 0,
                    totalLearned: categories.known.length
                }
            });
            return;
        }
        // --- END TOPIC MODE ---

        const userProfileRef = await db.collection('users').doc(String(userId)).get();
        const userProfile = userProfileRef.exists ? userProfileRef.data() : null;
        const userLevel = userProfile?.level || 'Intermediate';

        const now = new Date();
        const COOL_DOWN_HOURS = 20;

        const isCool = (timestamp) => {
            if (!timestamp) return true;
            const lastSeenDate = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
            const diffHours = (now - lastSeenDate) / (1000 * 60 * 60);
            return diffHours > COOL_DOWN_HOURS;
        };

        const availableLearning = categories.learning.filter(w => isCool(w.last_seen));

        const TARGET_COUNT = 8;
        const distribution = {
            new: 4,
            learning: 2,
            weak: 2,
            known: 0
        };

        let selectedWords = [];

        const shuffle = (arr) => arr.sort(() => 0.5 - Math.random());

        const shuffledWeak = shuffle([...categories.weak]);
        selectedWords.push(...shuffledWeak.slice(0, distribution.weak));

        const shuffledLearning = shuffle([...availableLearning]);
        selectedWords.push(...shuffledLearning.slice(0, distribution.learning));

        const currentCount = selectedWords.length;
        let neededNew = TARGET_COUNT - currentCount;
        if (neededNew < 0) neededNew = 0;

        const newWordsPool = vocabulary.filter(v => !userWordsMap.has(v.word));

        let filteredNewPool = newWordsPool;
        const advancesLevels = ['B1', 'B2', 'C1', 'C2'];
        const hardWords = newWordsPool.filter(w => advancesLevels.includes(w.level));

        if (hardWords.length >= neededNew) {
            filteredNewPool = hardWords;
        }

        const shuffledNewPool = shuffle(filteredNewPool);

        const pickedNew = shuffledNewPool.slice(0, neededNew).map(v => ({
            ...v,
            status: 'new',
            correct_streak: 0,
            wrong_count: 0
        }));

        selectedWords.push(...pickedNew);

        if (selectedWords.length < TARGET_COUNT) {
            const needed = TARGET_COUNT - selectedWords.length;
            const shuffledKnown = shuffle([...categories.known]);
            selectedWords.push(...shuffledKnown.slice(0, needed));
        }

        res.json({
            words: shuffle(selectedWords),
            stats: {
                totalKnown: categories.known.length,
                totalLearning: categories.learning.length,
                totalWeak: categories.weak.length
            }
        });

    } catch (error) {
        console.error("Error generating daily words", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== UPDATE WORD STATUS =====
app.post('/updateWordStatus', async (req, res) => {
    const requestData = req.body.data || req.body;
    const { userId, word, isCorrect, language } = requestData;

    if (!userId || !word) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const lang = language || 'en';
    const docRef = db.collection(`users/${userId}/user_words_${lang}`).doc(word);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(docRef);
            let data = doc.exists ? doc.data() : {
                word,
                correct_streak: 0,
                wrong_count: 0,
                status: 'new',
            };

            if (isCorrect) {
                data.correct_streak = (data.correct_streak || 0) + 1;
                if (data.correct_streak >= 3) {
                    data.status = 'known';
                } else {
                    if (data.status === 'new' || data.status === 'weak') {
                        data.status = 'learning';
                    }
                }
            } else {
                data.correct_streak = 0;
                data.wrong_count = (data.wrong_count || 0) + 1;
                if (data.wrong_count >= 1) {
                    data.status = 'weak';
                } else {
                    data.status = 'learning';
                }
            }

            data.last_seen = admin.firestore.FieldValue.serverTimestamp();

            if (!doc.exists) {
                const vocabItem = vocabulary.find(v => v.word === word);
                if (vocabItem) {
                    data = { ...vocabItem, ...data };
                }
            }

            t.set(docRef, data, { merge: true });
        });

        res.json({ success: true });
    } catch (e) {
        console.error("Update word status failed", e);
        res.status(500).json({ error: e.message });
    }
});

// ===== MARK DAILY MASTERED =====
app.post('/markDailyMastered', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const date = requestData.date || new Date().toISOString().split('T')[0];
    const language = requestData.language || 'en';

    if (!userId) {
        return res.status(400).json({ error: "No user ID" });
    }

    try {
        const docId = `${userId}_${language}_${date}`;
        const docRef = db.collection('daily_words').doc(docId);

        await docRef.set({
            mastered: true,
            masteredAt: admin.firestore.FieldValue.serverTimestamp(),
            userId: userId,
            date: date,
            language
        }, { merge: true });

        res.json({ success: true });

    } catch (error) {
        console.error("Error marking daily words as mastered", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== GET WORD HISTORY =====
app.post('/getWordHistory', async (req, res) => {
    const requestData = req.body.data || req.body;
    const userId = requestData.userId;
    const language = requestData.language || 'en';

    if (!userId) {
        return res.status(400).json({ error: "No user ID" });
    }

    try {
        const snapshot = await db.collection(`users/${userId}/user_words_${language}`).get();

        const history = {
            known: [],
            learning: [],
            weak: []
        };

        snapshot.forEach(doc => {
            const data = doc.data();
            const status = data.status || 'learning';

            if (history[status]) {
                history[status].push(data);
            } else if (status === 'new') {
                history.learning.push(data);
            }
        });

        const sortFn = (a, b) => (b.last_seen?._seconds || 0) - (a.last_seen?._seconds || 0);
        history.known.sort(sortFn);
        history.learning.sort(sortFn);
        history.weak.sort(sortFn);

        res.json({ history });

    } catch (error) {
        console.error("Error fetching word history", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== GET GRAMMAR PILLS =====
app.post('/getGrammarPills', async (req, res) => {
    try {
        res.json({ pills: grammar });
    } catch (error) {
        console.error("Error fetching grammar pills", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== ANALYZE IMAGE =====
app.post('/analyzeImage', async (req, res) => {
    const requestData = req.body.data || req.body;
    const imageUrl = requestData.imageUrl;
    const targetLang = requestData.targetLang || 'ru';

    if (!imageUrl) {
        return res.status(400).json({ error: "No image URL provided" });
    }

    try {
        // Fetch image and convert to base64
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

        const prompt = `Analyze this image and describe its content in detail. Then, identify any text present in the image and translate it to ${targetLang === 'ru' ? 'Russian' : 'English'}. Structure your response as follows:
        Description: [Detailed description of the image content]
        Detected Text: [Original text found in the image, if any]
        Translated Text: [Translated text, if any]`;

        const completion = await openai.chat.completions.create({
            model: "google/gemini-2.0-flash-001",
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                    ]
                }
            ],
        });

        const analysis = completion.choices[0].message.content.trim();
        res.json({ analysis });

    } catch (error) {
        console.error("Error analyzing image", error);
        res.status(500).json({ error: error.message });
    }
});

// ===== TRANSLATE WORD =====
app.post('/translateWord', async (req, res) => {
    const requestData = req.body.data || req.body;
    const text = requestData.text;
    const targetLang = requestData.targetLang || 'ru';

    if (!text) {
        return res.status(400).json({ error: "No text provided" });
    }

    try {
        const prompt = `Translate the word or phrase "${text}" to ${targetLang === 'ru' ? 'Russian' : 'English'}. Return only the translation.`;

        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
        });

        const translatedText = completion.choices[0].message.content.trim();
        res.json({ translation: translatedText });

    } catch (error) {
        console.error("Error translating word", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Using OpenRouter API with model: ${AI_MODEL}`);
});
