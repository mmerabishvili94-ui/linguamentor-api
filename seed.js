const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json"); // User needs to provide this for local seeding, or run via firebase shell

// If running in local emulator or having proper auth:
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
    } catch (e) {
        console.log("Please ensure you are authenticated via 'gcloud auth application-default login' or provide serviceAccountKey.json");
        process.exit(1);
    }
}

const db = admin.firestore();

const OWNER_TELEGRAM_ID = 102436862;

async function seed() {
    console.log("Seeding database for user:", OWNER_TELEGRAM_ID);

    const userRef = db.collection('users').doc(String(OWNER_TELEGRAM_ID));

    await userRef.set({
        name: "Merab",
        level: "Intermediate",
        goals: "Improve fluency and business vocabulary",
        weakPoints: ["Prepositions", "Articles", "Complex Tenses"],
        vocabulary: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log("User profile created/updated!");

    // Create a welcome message
    await db.collection(`dialogs/${OWNER_TELEGRAM_ID}/messages`).add({
        role: 'assistant',
        text: "Hello Merab! I am your personal English tutor. I've reviewed your profile. Ready to start our lesson?",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("Welcome message added!");
}

seed().catch(console.error);
