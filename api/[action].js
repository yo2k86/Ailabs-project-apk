import admin from 'firebase-admin';
import crypto from 'crypto';

// ==========================================
// INISIALISASI FIREBASE ADMIN (Hanya 1 kali)
// ==========================================
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            })
        });
    } catch (error) {
        console.error('Firebase admin error', error);
    }
}
const db = admin.firestore();

export default async function handler(req, res) {
    // Vercel Dynamic Route: Tangani param dari req.query.action atau req.body.action
    let action = req.query.action;
    
    // SISTEM PINTAR: Jika HTML memanggil tanpa query string di body (misal POST)
    if (!action && req.body && req.body.action) {
        action = req.body.action;
    }

    const apiKey = process.env.KIE_API_KEY;

    // ========================================================
    // ROUTE DATABASE & ADMIN (Tidak butuh KIE_API_KEY)
    // ========================================================
    try {
        if (action === 'redeem') return await handleRedeem(req, res, db);
        if (action === 'history') return await handleHistory(req, res, db);
        if (action === 'get_users') return await handleGetUsers(req, res, db);
        if (action === 'topup') return await handleTopup(req, res, db);
        if (action === 'toggle_access') return await handleToggleAccess(req, res, db);
        if (action === 'get_referrals') return await handleGetReferrals(req, res, db);
        if (action === 'webhook') return await handleWebhook(req, res, db, admin); 
    } catch (error) {
        console.error(`Error on DB route /api/${action}:`, error);
        return res.status(500).json({ error: "Internal Server Error", message: error.message });
    }

    // ========================================================
    // ROUTE GENERATE AI
    // ========================================================
    if (!apiKey) {
        return res.status(500).json({ error: "KIE_API_KEY belum dipasang di environment Vercel!" });
    }

    try {
        switch (action) {
            case 'check': return await handleCheck(req, res, apiKey, db, admin); 
            case 'download': return await handleDownload(req, res, apiKey);
            case 'generate': return await handleGenerate(req, res, apiKey, db, admin);
            case 'upload': return await handleUpload(req, res, apiKey);
            case 'upload-url': return await handleUploadUrl(req, res, apiKey);
            case 'veo-action': return await handleVeoAction(req, res, apiKey);
            case 'kie-balance': return await handleKieBalance(req, res, apiKey);
            default: return res.status(404).json({ error: `Endpoint API action '${action}' tidak ditemukan.` });
        }
    } catch (error) {
        console.error(`Error on AI route /api/${action}:`, error);
        return res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
}

// ==========================================
// 1. FUNGSI CHECK (Mengecek Status Task & Auto-Refund)
// ==========================================
async function handleCheck(req, res, apiKey, db, admin) {
  let taskId = req.query.taskId;
  let engine = req.query.engine;
  // Gunakan appId bawaan sebagai fallback untuk mencegah error Index
  let appId = req.query.appId || '1:290208256362:web:b5022be8bd57311f9cd513';

  // PENGAMAN KHUSUS VERCEL: Paksa ambil dari raw URL jika req.query.taskId kosong
  if (!taskId && req.url && req.url.includes('?')) {
      const urlParams = new URLSearchParams(req.url.split('?')[1]);
      taskId = taskId || urlParams.get('taskId');
      engine = engine || urlParams.get('engine');
      appId = urlParams.get('appId') || appId;
  }

  if (!taskId) return res.status(400).json({ error: "Parameter taskId tidak ditemukan" });

  try {
    let endpoint = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`;
    
    // KHUSUS VEO: record-info
    if ((engine && engine.toLowerCase().includes("veo")) || taskId.startsWith("veo_")) {
        endpoint = `https://api.kie.ai/api/v1/veo/record-info?taskId=${taskId}`;
    }

    const response = await fetch(endpoint, {
      method: "GET", 
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }
    });

    const data = await response.json();

    // AUTO-REFUND SISTEM USER
    // Mengecek apakah respons dari AI berupa error / gagal
    let rawStatus = data.data?.state ?? data.data?.successFlag ?? data.data?.status ?? data.status ?? data.successFlag ?? "";
    let statusStr = String(rawStatus).toLowerCase();
    const isFail = ['fail', 'failed', 'error', '2', '3'].includes(statusStr);

    if (isFail && taskId && db && admin) {
        try {
            // Membaca langsung dari spesifik path agar tidak terkena pemblokiran Missing Index Firestore
            const historyRef = db.collection('artifacts').doc(appId).collection('history').doc(taskId);
            
            await db.runTransaction(async (t) => {
                const historySnap = await t.get(historyRef);
                if (historySnap.exists) {
                    const historyData = historySnap.data();
                    
                    // Pastikan belum pernah direfund untuk mencegah double refund
                    if (historyData.status !== 'FAILED_REFUNDED') {
                        const refundCost = historyData.cost || 0;
                        const hUserId = historyData.userId;
                        
                        // Kembalikan Kredit ke User dengan Transaction
                        if (refundCost > 0 && hUserId) {
                            const userRef = db.collection('artifacts').doc(appId).collection('users').doc(hUserId).collection('profile').doc('data');
                            t.update(userRef, { credits: admin.firestore.FieldValue.increment(refundCost) });
                        }
                        
                        // Kunci status agar aman
                        t.update(historyRef, {
                            status: 'FAILED_REFUNDED',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                }
            });
        } catch (e) {
            console.error("Gagal melakukan auto-refund user saat polling check:", e);
        }
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Gagal cek status dari Kie AI.", message: error.message });
  }
}

// ==========================================
// 2. FUNGSI CONVERT TEMPFILE KE DOWNLOAD URL
// ==========================================
async function handleDownload(req, res, apiKey) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Harus POST' });
    if (!req.body.url) return res.status(400).json({ error: 'URL file tidak boleh kosong' });
    
    try {
        const response = await fetch("https://api.kie.ai/api/v1/common/download-url", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ url: req.body.url })
        });

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("Respons dari KIE bukan JSON.");
        }

        const result = await response.json();
        
        if (result.code !== 200) {
            console.warn("Kie Download URL warning:", result.msg);
            return res.status(200).json({ data: req.body.url, warning: result.msg });
        }

        return res.status(200).json({ data: result.data || req.body.url });

    } catch (e) {
        console.error("Error on download convert:", e.message);
        return res.status(200).json({ data: req.body.url, error: e.message });
    }
}

// ==========================================
// 3. FUNGSI UTAMA GENERATE AI
// ==========================================
async function handleGenerate(req, res, apiKey, db, admin) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode harus POST' });

  const { image_urls = [], video_urls = [], prompt, engine, ratio, type, duration, mode, character_orientation, background_source, userId, appId } = req.body;

  // ==========================================
  // HITUNG BIAYA (COST) SINKRON DENGAN KIE.AI
  // ==========================================
  let cost = 1; 
  const engineName = (engine || '').toLowerCase();
  let incomingMode = String(mode || "720p").toLowerCase();
  let safeDuration = parseInt(duration) || 5; 
  
  if (type === 'Gambar') {
      cost = 1;
  } else if (engineName === 'grok') {
      const grokDur = parseInt(duration) || 6;
      cost = (grokDur / 6) * 18; 
  } else if (engineName.includes('veo3.1 lite') || engineName.includes('veo3.1 fast')) {
      cost = 30; 
  } else if (engineName.includes('veo3.1 quality')) {
      cost = 50; 
  } else if (engineName.includes('kling 3.0')) {
      if (incomingMode === "1080p" || incomingMode === "pro") {
          cost = safeDuration * 27;
      } else {
          cost = safeDuration * 20;
      }
  } else if (engineName.includes('kling')) { 
      cost = safeDuration * 11;
  } else if (type === 'Video' || type === 'Motion') {
      cost = 5; 
  }

  // POTONG KREDIT VIA FIREBASE ADMIN
  if (!userId) {
      return res.status(401).json({ error: "Unauthorized. Harap login kembali." });
  }
  if (!appId) {
      return res.status(400).json({ error: "appId tidak ditemukan dari aplikasi frontend. Silakan refresh aplikasi." });
  }

  if (cost) {
      try {
          const userRef = db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('profile').doc('data');
          const userDoc = await userRef.get();
          
          if (!userDoc.exists) return res.status(403).json({ error: "Akun tidak ditemukan. Silakan reload aplikasi." });
          
          const userData = userDoc.data();
          if ((type === 'Video' || type === 'Motion') && userData.videoAccess === false) {
              return res.status(403).json({ error: "Akses pembuatan video untuk akun kamu sedang dibekukan oleh Admin." });
          }

          const currentCredits = userData.credits || 0;
          if (currentCredits < cost) return res.status(403).json({ error: `Kredit habis. Sisa ${currentCredits} ⚡, butuh ${cost} ⚡.` });

          await userRef.update({ credits: admin.firestore.FieldValue.increment(-cost) });
      } catch (err) {
          return res.status(500).json({ error: "Sistem kredit gagal. Cek konfigurasi Firebase." });
      }
  }

  // ==========================================
  // LOGIKA PAYLOAD KIE AI
  // ==========================================
  try {
    let endpoint = 'https://api.kie.ai/api/v1/jobs/createTask';
    let payload = {};

    if (type === 'Motion' || (engine && engine.includes('Kling'))) {
        const isKling3 = engine === 'Kling 3.0';
        let klingMode = incomingMode;
        if (isKling3) {
            if (klingMode === "720p") klingMode = "std";
            if (klingMode === "1080p") klingMode = "pro";
            if (klingMode !== "std" && klingMode !== "pro") klingMode = "std";
        } else {
            if (klingMode === "std") klingMode = "720p";
            if (klingMode === "pro") klingMode = "1080p";
            if (klingMode !== "720p" && klingMode !== "1080p") klingMode = "720p";
        }

        payload = {
            model: isKling3 ? "kling-3.0/motion-control" : "kling-2.6/motion-control",
            input: {
                prompt: prompt || "No distortion, the character's movements are consistent with the video.",
                input_urls: image_urls.length > 0 ? [image_urls[0]] : [], 
                video_urls: video_urls.length > 0 ? [video_urls[0]] : [],
                character_orientation: character_orientation || "video",
                mode: klingMode,
                duration: safeDuration 
            }
        };
        if (isKling3 && background_source) {
            payload.input.background_source = background_source;
        }
    }
    else if (engine && engine.toLowerCase().includes('grok')) {
        const hasImages = image_urls && image_urls.length > 0;
        if (type === 'Video') {
            const modelName = hasImages ? "grok-imagine/image-to-video" : "grok-imagine/text-to-video";
            
            let safeMode = "normal";
            if (incomingMode === "spicy") safeMode = "spicy";
            if (incomingMode === "fun") safeMode = "fun";
            if (hasImages && safeMode === 'spicy') safeMode = "normal";

            let safeGrokDuration = parseInt(duration) || 6;
            safeGrokDuration = Math.min(Math.max(safeGrokDuration, 6), 30);

            payload = {
                model: modelName,
                input: {
                    prompt: prompt ? prompt.substring(0, 4900) : "Cinematic aesthetic movement",
                    aspect_ratio: ratio || "16:9",
                    mode: safeMode,
                    duration: String(safeGrokDuration),
                    resolution: "720p",
                    nsfw_checker: false
                }
            };
            if (hasImages) payload.input.image_urls = image_urls.slice(0, 7);
        } else if (type === 'Gambar') {
            if (hasImages) {
                payload = {
                    model: "grok-imagine/image-to-image",
                    input: { prompt: prompt || "Maintain consistency", image_urls: [image_urls[0]], nsfw_checker: false }
                };
            } else {
                payload = {
                    model: "grok-imagine/text-to-image",
                    input: { prompt: prompt, aspect_ratio: ratio || "16:9" }
                };
            }
        }
    } 
    else {
        endpoint = 'https://api.kie.ai/api/v1/veo/generate';
        let veoModel = "veo3_fast"; 
        if (engine === 'veo3.1 lite') veoModel = "veo3_lite";
        else if (engine === 'veo3.1 quality') veoModel = "veo3";

        payload = {
            model: veoModel,
            prompt: prompt || "Cinematic aesthetic generation",
            aspect_ratio: ratio || "16:9"
        };
        if (image_urls && image_urls.length > 0) {
            payload.imageUrls = image_urls;
            payload.image_urls = image_urls; 
        }
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // REFUND JIKA GAGAL SAAT GENERATE (Synchronous Error)
    if (!response.ok || (data.code && data.code !== 200)) {
        console.error("🔴 KIE AI REJECTED REQUEST:", JSON.stringify(data));
        
        if (userId && appId && cost) {
            const userRef = db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('profile').doc('data');
            await userRef.update({ credits: admin.firestore.FieldValue.increment(cost) });
        }
        let errorMsg = "Gagal memproses task.";
        if (data.msg) errorMsg = data.msg;
        else if (data.message) errorMsg = data.message;
        else if (data.error && data.error.message) errorMsg = data.error.message;
        
        return res.status(400).json({ error: `Kie AI Error: ${errorMsg}` });
    }

    // SIMPAN HISTORY & COST UNTUK AUTO-REFUND ASYNC
    const taskId = data.data?.taskId || data.taskId || data.task_id;
    if (userId && appId && taskId) {
        try {
            const userRef = db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('profile').doc('data');
            const userDoc = await userRef.get();
            const uName = userDoc.exists ? userDoc.data().name : 'User';
            const uEmail = userDoc.exists ? userDoc.data().email : 'No Email';

            await db.collection('artifacts').doc(appId).collection('history').doc(taskId).set({
                taskId: taskId,
                userId: userId,
                userName: uName,
                userEmail: uEmail,
                prompt: prompt || "Tanpa prompt",
                engine: engine || "Kie.ai Engine",
                type: type || "Video",
                cost: cost, // HARGA DISIMPAN DISINI UNTUK REFUND
                status: 'PROCESSING',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error("Gagal simpan riwayat:", e);
        }
    }

    return res.status(response.status).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Terjadi kesalahan sistem di Vercel', message: error.message });
  }
}

// ==========================================
// 4. FUNGSI REDEEM KODE PROMO
// ==========================================
async function handleRedeem(req, res, db) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Harus POST' });
    const { userId, appId, code } = req.body;

    if (!userId || !appId || !code) return res.status(400).json({ error: "Data tidak lengkap" });

    // Daftar semua kode yang valid
    const validCodes = [
        "AL-9A2X", "AL-3B7K", "AL-8C4M", "AL-1D9P", "AL-5E6R", "AL-7F3T", "AL-2G8V", "AL-6H5Y", "AL-4J1Z", "AL-9K3B",
        "AL-2L7C", "AL-8M4D", "AL-3N9F", "AL-5P6G", "AL-7Q2H", "AL-1R8J", "AL-6T5K", "AL-4V1L", "AL-9W3M", "AL-2X7N",
        "AL-8Y4P", "AL-3Z9Q", "AL-5A6R", "AL-7B2T", "AL-1C8V", "AL-6D5W", "AL-4E1X", "AL-9F3Y", "AL-2G7Z", "AL-8H4A",
        "VIP-A1X9", "VIP-B2Y8", "VIP-C3Z7", "VIP-D4A6", "VIP-E5B5", "VIP-F6C4", "VIP-G7D3", "VIP-H8E2", "VIP-J9F1", "VIP-K1G9",
        "VIP-L2H8", "VIP-M3J7", "VIP-N4K6", "VIP-P5L5", "VIP-Q6M4", "VIP-R7N3", "VIP-T8P2", "VIP-V9Q1", "VIP-W1R9", "VIP-X2T8",
        "VIP-Y3V7", "VIP-Z4W6", "VIP-A5X5", "VIP-B6Y4", "VIP-C7Z3", "VIP-D8A2", "VIP-E9B1", "VIP-F1C9", "VIP-G2D8", "VIP-H3E7",
        "PRO-1A2B", "PRO-3C4D", "PRO-5E6F", "PRO-7G8H", "PRO-9J1K", "PRO-2L3M", "PRO-4N5P", "PRO-6Q7R", "PRO-8T9V", "PRO-1W2X",
        "PRO-3Y4Z", "PRO-5A6C", "PRO-7E8G", "PRO-9J1L", "PRO-2N3Q", "PRO-4T5W", "PRO-6Y7A", "PRO-8D9F", "PRO-1H2K", "PRO-3M4P",
        "PRO-5R6T", "PRO-7V8X", "PRO-9Z1B", "PRO-2C3E", "PRO-4G5J", "PRO-6L7N", "PRO-8Q9S", "PRO-1U2W", "PRO-3Y4A", "PRO-5C6D",
        "GEN-9Z8Y", "GEN-7X6W", "GEN-5V4T", "GEN-3R2Q", "GEN-1P9N", "GEN-8M7L", "GEN-6K5J", "GEN-4H3G", "GEN-2F1E", "GEN-9D8C",
        "GEN-7B6A", "GEN-5Z4Y", "GEN-3X2W", "GEN-1V9T", "GEN-8R7Q", "GEN-6P5N", "GEN-4M3L", "GEN-2K1J", "GEN-9H8G", "GEN-7F6E",
        "GEN-5D4C", "GEN-3B2A", "GEN-1Z9Y", "GEN-8X7W", "GEN-6V5T", "GEN-4R3Q", "GEN-2P1N", "GEN-9M8L", "GEN-7K6J", "GEN-5H4G",
        "NANO-A111", "NANO-B222", "NANO-C333", "NANO-D444", "NANO-E555", "NANO-F666", "NANO-G777", "NANO-H888", "NANO-J999", "NANO-K101",
        "NANO-L202", "NANO-M303", "NANO-N404", "NANO-P505", "NANO-Q606", "NANO-R707", "NANO-T808", "NANO-V909", "NANO-W121", "NANO-X232",
        "NANO-Y343", "NANO-Z454", "NANO-A565", "NANO-B676", "NANO-C787", "NANO-D898", "NANO-E909", "NANO-F131", "NANO-G242", "NANO-H353",
        "ART-1X1A", "ART-2X2B", "ART-3X3C", "ART-4X4D", "ART-5X5E", "ART-6X6F", "ART-7X7G", "ART-8X8H", "ART-9X9J", "ART-1Y1K",
        "ART-2Y2L", "ART-3Y3M", "ART-4Y4N", "ART-5Y5P", "ART-6Y6Q", "ART-7Y7R", "ART-8Y8T", "ART-9Y9V", "ART-1Z1W", "ART-2Z2X",
        "ART-3Z3Y", "ART-4Z4Z", "ART-5A5A", "ART-6A6B", "ART-7A7C", "ART-8A8D", "ART-9A9E", "ART-1B1F", "ART-2B2G", "ART-3B3H",
        "AILABS-001", "AILABS-002", "AILABS-003", "AILABS-004", "AILABS-005", "AILABS-006", "AILABS-007", "AILABS-008", "AILABS-009", "AILABS-010",
        "AILABS-011", "AILABS-012", "AILABS-013", "AILABS-014", "AILABS-015", "AILABS-016", "AILABS-017", "AILABS-018", "AILABS-019", "AILABS-020",
        "AILABS-021", "AILABS-022", "AILABS-023", "AILABS-024", "AILABS-025", "AILABS-026", "AILABS-027", "AILABS-028", "AILABS-029", "AILABS-030",
        "AILABS-031", "AILABS-032", "AILABS-033", "AILABS-034", "AILABS-035", "AILABS-036", "AILABS-037", "AILABS-038", "AILABS-039", "AILABS-040",
        "AILABS-041", "AILABS-042", "AILABS-043", "AILABS-044", "AILABS-045", "AILABS-046", "AILABS-047", "AILABS-048", "AILABS-049", "AILABS-050",
        "AILABS-051", "AILABS-052", "AILABS-053", "AILABS-054", "AILABS-055", "AILABS-056", "AILABS-057", "AILABS-058", "AILABS-059", "AILABS-060",
        "VEO-9A1", "VEO-8B2", "VEO-7C3", "VEO-6D4", "VEO-5E5", "VEO-4F6", "VEO-3G7", "VEO-2H8", "VEO-1J9", "VEO-9K1",
        "VEO-8L2", "VEO-7M3", "VEO-6N4", "VEO-5P5", "VEO-4Q6", "VEO-3R7", "VEO-2T8", "VEO-1V9", "VEO-9W1", "VEO-8X2",
        "VEO-7Y3", "VEO-6Z4", "VEO-5A5", "VEO-4B6", "VEO-3C7", "VEO-2D8", "VEO-1E9", "VEO-9F1", "VEO-8G2", "VEO-7H3",
        "GROK-12A", "GROK-34B", "GROK-56C", "GROK-78D", "GROK-90E", "GROK-21F", "GROK-43G", "GROK-65H", "GROK-87J", "GROK-09K",
        "GROK-13L", "GROK-24M", "GROK-35N", "GROK-46P", "GROK-57Q", "GROK-68R", "GROK-79T", "GROK-80V", "GROK-91W", "GROK-02X",
        "GROK-14Y", "GROK-25Z", "GROK-36A", "GROK-47B", "GROK-58C", "GROK-69D", "GROK-70E", "GROK-81F", "GROK-92G", "GROK-03H"
    ];

    const inputCode = code.toUpperCase();
    if (!validCodes.includes(inputCode)) {
        return res.status(400).json({ success: false, error: "Kode tidak valid! Periksa kembali penulisan kodenya." });
    }

    try {
        const userRef = db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('profile').doc('data');
        
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("Data user belum diinisialisasi di database.");
            
            const userData = userDoc.data();
            if (userData.hasRedeemed) throw new Error("Jatah klaim hanya 1x per akun.");

            const usersSnapshot = await t.get(db.collection('artifacts').doc(appId).collection('users'));
            for (const doc of usersSnapshot.docs) {
                const profileRef = db.collection('artifacts').doc(appId).collection('users').doc(doc.id).collection('profile').doc('data');
                const profileSnap = await t.get(profileRef);
                if (profileSnap.exists && profileSnap.data().redeemedCode === inputCode) {
                    throw new Error("Kode ini sudah digunakan oleh orang lain.");
                }
            }

            const currentCredits = userData.credits || 0;
            t.update(userRef, { credits: currentCredits + 200, hasRedeemed: true, redeemedCode: inputCode });
            return true;
        });

        return res.status(200).json({ success: true, message: "Selamat! 200 Kredit berhasil ditambahkan." });
    } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
    }
}

// ==========================================
// 5. FUNGSI UPLOAD IMAGE
// ==========================================
async function handleUpload(req, res, apiKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Harus POST' });
  try {
    const { base64Data, uploadPath, fileName } = req.body;
    if (!base64Data) return res.status(400).json({ error: 'Data base64 tidak ditemukan' });

    const response = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data, uploadPath: uploadPath || 'ailabs-uploads', fileName: fileName || `upload_${Date.now()}.jpg` })
    });

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) throw new Error("Gagal mengunggah, respons server bukan JSON.");
    
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Gagal mengunggah', message: error.message });
  }
}

// ==========================================
// 6. FUNGSI UPLOAD URL / VIDEO
// ==========================================
async function handleUploadUrl(req, res, apiKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Harus POST' });
  try {
    const { fileUrl, uploadPath, fileName } = req.body;
    if (!fileUrl) return res.status(400).json({ error: 'URL file tidak ditemukan' });

    const response = await fetch('https://kieai.redpandaai.co/api/file-url-upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl, uploadPath: uploadPath || 'ailabs-url-uploads', fileName: fileName || `url_import_${Date.now()}.jpg` })
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Gagal import URL', message: error.message });
  }
}

// ==========================================
// 7. FUNGSI VEO ACTION (Extend/Upscale)
// ==========================================
async function handleVeoAction(req, res, apiKey) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode harus POST' });
  const { action, taskId, prompt } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId wajib diisi!' });

  try {
    let endpoint = '';
    let method = 'POST';
    let payload = null;

    if (action === 'extend') {
      endpoint = 'https://api.kie.ai/api/v1/veo/extend';
      payload = { taskId, prompt: prompt || "Continue the video naturally", model: "fast" };
    } else if (action === '1080p') {
      endpoint = `https://api.kie.ai/api/v1/veo/get-1080p-video?taskId=${taskId}`;
      method = 'GET';
    } else if (action === '4k') {
      endpoint = 'https://api.kie.ai/api/v1/veo/get-4k-video';
      payload = { taskId, index: 0 };
    } else {
      return res.status(400).json({ error: 'Action tidak valid' });
    }

    const options = { method, headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } };
    if (payload) options.body = JSON.stringify(payload);

    const response = await fetch(endpoint, options);
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) throw new Error("Respons dari server KIE bukan JSON.");

    const data = await response.json();

    if (action === '1080p' || action === '4k') {
      if (response.status === 200 && data.data?.resultUrl) {
         return res.status(200).json({ url: data.data.resultUrl });
      } else if (response.status === 200 && data.data?.resultUrls?.length > 0) {
         return res.status(200).json({ url: data.data.resultUrls[0] });
      } else if (response.status === 400 || response.status === 422) {
         if (data.msg && data.msg.toLowerCase().includes('processing')) {
             return res.status(200).json({ processing: true, msg: data.msg });
         } else if (data.msg && data.msg.includes('successfully') && data.data?.resultUrls?.length > 0) {
             return res.status(200).json({ url: data.data.resultUrls[0] });
         }
      }
    }
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Gagal request Veo Action', message: error.message });
  }
}

// ==========================================
// 8. FUNGSI HISTORY & ADMIN UTILITIES
// ==========================================
async function handleHistory(req, res, db) {
    const { adminCode, appId } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    const targetAppId = appId || '1:290208256362:web:b5022be8bd57311f9cd513';
    try {
        const historySnapshot = await db.collection('artifacts').doc(targetAppId).collection('history').orderBy('timestamp', 'desc').limit(50).get();
        let historyList = [];
        historySnapshot.forEach(doc => {
            const data = doc.data();
            historyList.push({
                id: doc.id, taskId: data.taskId, userName: data.userName || 'Anonim',
                userEmail: data.userEmail || 'Tidak ada', prompt: data.prompt || '-',
                engine: data.engine || '-', type: data.type || '-',
                timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : new Date().toISOString()
            });
        });
        return res.status(200).json({ success: true, history: historyList });
    } catch (error) { return res.status(500).json({ error: "Gagal mengambil riwayat" }); }
}

async function handleKieBalance(req, res, apiKey) {
    const { adminCode } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    try {
        const response = await fetch("https://api.kie.ai/api/v1/chat/credit", {
            method: "GET", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }
        });
        const data = await response.json();
        if (data.code === 200) return res.status(200).json({ success: true, balance: data.data });
        else return res.status(400).json({ success: false, error: data.msg });
    } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
}

async function handleGetUsers(req, res, db) {
    const { adminCode, appId } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    const targetAppId = appId || '1:290208256362:web:b5022be8bd57311f9cd513';
    try {
        const profilesSnapshot = await db.collectionGroup('profile').get();
        let usersList = [];
        for (const profileDoc of profilesSnapshot.docs) {
            const pathSegments = profileDoc.ref.path.split('/');
            if (pathSegments.length >= 4 && pathSegments[1] === targetAppId) {
                const uid = pathSegments[3]; const data = profileDoc.data();
                usersList.push({ uid, name: data.name || 'User', email: data.email || 'Anonim', isAnon: data.isAnon || false, credits: data.credits || 0, videoAccess: data.videoAccess !== false });
            }
        }
        return res.status(200).json({ success: true, users: usersList });
    } catch (error) { return res.status(500).json({ error: "Gagal mengambil data user" }); }
}

async function handleTopup(req, res, db) {
    const { adminCode, appId, targetUid, amount } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    try {
        const profileRef = db.collection('artifacts').doc(appId).collection('users').doc(targetUid).collection('profile').doc('data');
        await db.runTransaction(async (t) => {
            const doc = await t.get(profileRef);
            if (!doc.exists) throw new Error("User tidak ditemukan di database");
            t.update(profileRef, { credits: Math.max(0, (doc.data().credits || 0) + amount) });
        });
        return res.status(200).json({ success: true, message: "Topup berhasil" });
    } catch (error) { return res.status(500).json({ error: "Gagal topup" }); }
}

async function handleToggleAccess(req, res, db) {
    const { adminCode, appId, targetUid, videoAccess } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    try {
        await db.collection('artifacts').doc(appId).collection('users').doc(targetUid).collection('profile').doc('data').update({ videoAccess });
        return res.status(200).json({ success: true, message: "Akses diupdate" });
    } catch (error) { return res.status(500).json({ error: "Gagal update akses" }); }
}

async function handleGetReferrals(req, res, db) {
    const { adminCode, appId } = req.body;
    if (adminCode !== 'admin123' && adminCode !== 'Kr333wol') return res.status(403).json({ error: "Akses Ditolak" });
    const targetAppId = appId || '1:290208256362:web:b5022be8bd57311f9cd513';
    try {
        const profilesSnapshot = await db.collectionGroup('profile').get();
        let usedCodesMap = {};
        for (const profileDoc of profilesSnapshot.docs) {
            const pathSegments = profileDoc.ref.path.split('/');
            if (pathSegments.length >= 4 && pathSegments[1] === targetAppId) {
                const data = profileDoc.data();
                if (data.redeemedCode) usedCodesMap[data.redeemedCode.toUpperCase()] = data.email || pathSegments[3];
            }
        }
        
        // PERBAIKAN: Masukkan SEMUA kode agar tidak terpotong di Admin Panel
        const allCodes = [
            "AL-9A2X", "AL-3B7K", "AL-8C4M", "AL-1D9P", "AL-5E6R", "AL-7F3T", "AL-2G8V", "AL-6H5Y", "AL-4J1Z", "AL-9K3B",
            "AL-2L7C", "AL-8M4D", "AL-3N9F", "AL-5P6G", "AL-7Q2H", "AL-1R8J", "AL-6T5K", "AL-4V1L", "AL-9W3M", "AL-2X7N",
            "AL-8Y4P", "AL-3Z9Q", "AL-5A6R", "AL-7B2T", "AL-1C8V", "AL-6D5W", "AL-4E1X", "AL-9F3Y", "AL-2G7Z", "AL-8H4A",
            "VIP-A1X9", "VIP-B2Y8", "VIP-C3Z7", "VIP-D4A6", "VIP-E5B5", "VIP-F6C4", "VIP-G7D3", "VIP-H8E2", "VIP-J9F1", "VIP-K1G9",
            "VIP-L2H8", "VIP-M3J7", "VIP-N4K6", "VIP-P5L5", "VIP-Q6M4", "VIP-R7N3", "VIP-T8P2", "VIP-V9Q1", "VIP-W1R9", "VIP-X2T8",
            "VIP-Y3V7", "VIP-Z4W6", "VIP-A5X5", "VIP-B6Y4", "VIP-C7Z3", "VIP-D8A2", "VIP-E9B1", "VIP-F1C9", "VIP-G2D8", "VIP-H3E7",
            "PRO-1A2B", "PRO-3C4D", "PRO-5E6F", "PRO-7G8H", "PRO-9J1K", "PRO-2L3M", "PRO-4N5P", "PRO-6Q7R", "PRO-8T9V", "PRO-1W2X",
            "PRO-3Y4Z", "PRO-5A6C", "PRO-7E8G", "PRO-9J1L", "PRO-2N3Q", "PRO-4T5W", "PRO-6Y7A", "PRO-8D9F", "PRO-1H2K", "PRO-3M4P",
            "PRO-5R6T", "PRO-7V8X", "PRO-9Z1B", "PRO-2C3E", "PRO-4G5J", "PRO-6L7N", "PRO-8Q9S", "PRO-1U2W", "PRO-3Y4A", "PRO-5C6D",
            "GEN-9Z8Y", "GEN-7X6W", "GEN-5V4T", "GEN-3R2Q", "GEN-1P9N", "GEN-8M7L", "GEN-6K5J", "GEN-4H3G", "GEN-2F1E", "GEN-9D8C",
            "GEN-7B6A", "GEN-5Z4Y", "GEN-3X2W", "GEN-1V9T", "GEN-8R7Q", "GEN-6P5N", "GEN-4M3L", "GEN-2K1J", "GEN-9H8G", "GEN-7F6E",
            "GEN-5D4C", "GEN-3B2A", "GEN-1Z9Y", "GEN-8X7W", "GEN-6V5T", "GEN-4R3Q", "GEN-2P1N", "GEN-9M8L", "GEN-7K6J", "GEN-5H4G",
            "NANO-A111", "NANO-B222", "NANO-C333", "NANO-D444", "NANO-E555", "NANO-F666", "NANO-G777", "NANO-H888", "NANO-J999", "NANO-K101",
            "NANO-L202", "NANO-M303", "NANO-N404", "NANO-P505", "NANO-Q606", "NANO-R707", "NANO-T808", "NANO-V909", "NANO-W121", "NANO-X232",
            "NANO-Y343", "NANO-Z454", "NANO-A565", "NANO-B676", "NANO-C787", "NANO-D898", "NANO-E909", "NANO-F131", "NANO-G242", "NANO-H353",
            "ART-1X1A", "ART-2X2B", "ART-3X3C", "ART-4X4D", "ART-5X5E", "ART-6X6F", "ART-7X7G", "ART-8X8H", "ART-9X9J", "ART-1Y1K",
            "ART-2Y2L", "ART-3Y3M", "ART-4Y4N", "ART-5Y5P", "ART-6Y6Q", "ART-7Y7R", "ART-8Y8T", "ART-9Y9V", "ART-1Z1W", "ART-2Z2X",
            "ART-3Z3Y", "ART-4Z4Z", "ART-5A5A", "ART-6A6B", "ART-7A7C", "ART-8A8D", "ART-9A9E", "ART-1B1F", "ART-2B2G", "ART-3B3H",
            "AILABS-001", "AILABS-002", "AILABS-003", "AILABS-004", "AILABS-005", "AILABS-006", "AILABS-007", "AILABS-008", "AILABS-009", "AILABS-010",
            "AILABS-011", "AILABS-012", "AILABS-013", "AILABS-014", "AILABS-015", "AILABS-016", "AILABS-017", "AILABS-018", "AILABS-019", "AILABS-020",
            "AILABS-021", "AILABS-022", "AILABS-023", "AILABS-024", "AILABS-025", "AILABS-026", "AILABS-027", "AILABS-028", "AILABS-029", "AILABS-030",
            "AILABS-031", "AILABS-032", "AILABS-033", "AILABS-034", "AILABS-035", "AILABS-036", "AILABS-037", "AILABS-038", "AILABS-039", "AILABS-040",
            "AILABS-041", "AILABS-042", "AILABS-043", "AILABS-044", "AILABS-045", "AILABS-046", "AILABS-047", "AILABS-048", "AILABS-049", "AILABS-050",
            "AILABS-051", "AILABS-052", "AILABS-053", "AILABS-054", "AILABS-055", "AILABS-056", "AILABS-057", "AILABS-058", "AILABS-059", "AILABS-060",
            "VEO-9A1", "VEO-8B2", "VEO-7C3", "VEO-6D4", "VEO-5E5", "VEO-4F6", "VEO-3G7", "VEO-2H8", "VEO-1J9", "VEO-9K1",
            "VEO-8L2", "VEO-7M3", "VEO-6N4", "VEO-5P5", "VEO-4Q6", "VEO-3R7", "VEO-2T8", "VEO-1V9", "VEO-9W1", "VEO-8X2",
            "VEO-7Y3", "VEO-6Z4", "VEO-5A5", "VEO-4B6", "VEO-3C7", "VEO-2D8", "VEO-1E9", "VEO-9F1", "VEO-8G2", "VEO-7H3",
            "GROK-12A", "GROK-34B", "GROK-56C", "GROK-78D", "GROK-90E", "GROK-21F", "GROK-43G", "GROK-65H", "GROK-87J", "GROK-09K",
            "GROK-13L", "GROK-24M", "GROK-35N", "GROK-46P", "GROK-57Q", "GROK-68R", "GROK-79T", "GROK-80V", "GROK-91W", "GROK-02X",
            "GROK-14Y", "GROK-25Z", "GROK-36A", "GROK-47B", "GROK-58C", "GROK-69D", "GROK-70E", "GROK-81F", "GROK-92G", "GROK-03H"
        ];
        
        const result = allCodes.map(code => {
            const upperCode = code.toUpperCase();
            return { code: upperCode, used: !!usedCodesMap[upperCode], usedBy: usedCodesMap[upperCode] || null };
        });
        return res.status(200).json({ success: true, codes: result });
    } catch (error) { return res.status(500).json({ error: "Gagal mensinkronkan status kode" }); }
}

// ==========================================
// 9. FUNGSI WEBHOOK DARI KIE AI (Auto-Refund via Webhook)
// ==========================================
function generateSignature(taskId, timestampSeconds, secret) {
    const dataToSign = `${taskId}.${timestampSeconds}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(dataToSign);
    return hmac.digest('base64');
}

function verifySignature(taskId, timestampSeconds, receivedSignature, secret) {
    const expectedSignature = generateSignature(taskId, timestampSeconds, secret);
    if (expectedSignature.length !== receivedSignature.length) {
        return false;
    }
    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(receivedSignature)
    );
}

async function handleWebhook(req, res, db, admin) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Harus POST' });
    
    const WEBHOOK_HMAC_KEY = process.env.WEBHOOK_HMAC_KEY; 
    const timestamp = req.headers['x-webhook-timestamp'];
    const receivedSignature = req.headers['x-webhook-signature'];
    const data = req.body;

    // 1. VERIFIKASI KEAMANAN
    if (WEBHOOK_HMAC_KEY) {
        if (!timestamp || !receivedSignature) {
            console.warn("Webhook Ditolak: Header signature/timestamp hilang.");
            return res.status(401).json({ error: 'Missing signature headers' });
        }
        
        const verifyTaskId = data.data?.task_id;
        if (!verifyTaskId) {
            return res.status(400).json({ error: 'Missing task_id' });
        }

        const isValid = verifySignature(verifyTaskId, timestamp, receivedSignature, WEBHOOK_HMAC_KEY);
        if (!isValid) {
            console.warn("Webhook Ditolak: Signature tidak cocok dengan HMAC.");
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    // 2. PROSES UPDATE STATUS & AUTO-REFUND USER JIKA GAGAL
    const taskId = data.data?.task_id || data.taskId;
    const code = data.code;
    const defaultAppId = '1:290208256362:web:b5022be8bd57311f9cd513';

    if (taskId) {
        try {
            // Mencoba melakukan Update & Refund menggunakan ID Aplikasi Bawaan agar terhindar dari Error Index
            const historyRef = db.collection('artifacts').doc(defaultAppId).collection('history').doc(taskId);
            
            await db.runTransaction(async (t) => {
                const historySnap = await t.get(historyRef);
                if (historySnap.exists) {
                    const historyData = historySnap.data();
                    const isFail = code !== 200; 
                    
                    if (isFail && historyData.status !== 'FAILED_REFUNDED') {
                        const refundCost = historyData.cost || 0;
                        const hUserId = historyData.userId;

                        if (refundCost > 0 && hUserId) {
                            const userRef = db.collection('artifacts').doc(defaultAppId).collection('users').doc(hUserId).collection('profile').doc('data');
                            t.update(userRef, { credits: admin.firestore.FieldValue.increment(refundCost) });
                        }
                        
                        t.update(historyRef, {
                            status: 'FAILED_REFUNDED',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    } else if (!isFail && historyData.status !== 'SUCCESS') {
                        t.update(historyRef, {
                            status: 'SUCCESS',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                } else {
                    // Fallback apabila ada AppId berbeda (Meskipun butuh Index CollectionGroup)
                    const historyQuery = await db.collectionGroup('history').where('taskId', '==', taskId).get();
                    if (!historyQuery.empty) {
                        const doc = historyQuery.docs[0];
                        const historyData = doc.data();
                        const isFail = code !== 200;
                        
                        if (isFail && historyData.status !== 'FAILED_REFUNDED') {
                            const refundCost = historyData.cost || 0;
                            const hUserId = historyData.userId;
                            const hAppId = doc.ref.path.split('/')[1];

                            if (refundCost > 0 && hUserId && hAppId) {
                                const userRef = db.collection('artifacts').doc(hAppId).collection('users').doc(hUserId).collection('profile').doc('data');
                                t.update(userRef, { credits: admin.firestore.FieldValue.increment(refundCost) });
                            }
                            
                            t.update(doc.ref, {
                                status: 'FAILED_REFUNDED',
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        } else if (!isFail && historyData.status !== 'SUCCESS') {
                            t.update(doc.ref, {
                                status: 'SUCCESS',
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    }
                }
            });
        } catch (err) {
            console.error("Error update Firestore saat Webhook:", err);
        }
    }
    
    return res.status(200).json({ status: 'received' });
}
