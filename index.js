const express = require('express');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

const COMMISSION = parseInt(process.env.COMMISSION_AMOUNT) || 300;
const UPI_ID = process.env.UPI_ID;
const UPI_NAME = process.env.UPI_NAME;
const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Store conversation state in memory
const sessions = {};

// =====================================
// HELPER FUNCTIONS
// =====================================

async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message
    });
  } catch (err) {
    console.error('WhatsApp error:', err.message);
  }
}

function generateStars(rating) {
  if (!rating) return 'अभी कोई rating नहीं';
  const stars = Math.round(rating);
  return '⭐'.repeat(stars) + '☆'.repeat(5 - stars) + ` (${rating.toFixed(1)}/5)`;
}

function calculateInsurance(priceString) {
  const price = parseInt(priceString?.replace(/[^0-9]/g, '')) || 0;
  if (price <= 50000) return { totalPremium: 299, yourCut: 99, coverage: 50000 };
  if (price <= 100000) return { totalPremium: 499, yourCut: 149, coverage: 100000 };
  if (price <= 500000) return { totalPremium: 999, yourCut: 299, coverage: 500000 };
  return { totalPremium: 1999, yourCut: 499, coverage: 1000000 };
}

function removePhoneNumbers(text) {
  return text.replace(/(\+91|0)?[6-9]\d{9}/g, '[HIDDEN]');
}

function generateUPILink(amount, loadId) {
  return `upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(UPI_NAME)}&am=${amount}&cu=INR&tn=Commission-${loadId}`;
}

async function notifyDrivers(load) {
  const { data: drivers } = await supabase
    .from('drivers').select('*').eq('is_available', true);
  if (!drivers || drivers.length === 0) return 0;

  for (const driver of drivers) {
    // Set driver session to job offer mode
    sessions[driver.phone] = {
      role: 'driver',
      state: 'viewing_load',
      currentLoadId: load.id
    };

    await sendWhatsApp(driver.phone,
      `🚛 *नया लोड आया है!*\n\n` +
      `📍 कहाँ से: *${load.from_city}*\n` +
      `🏁 कहाँ तक: *${load.to_city}*\n` +
      `⚖️ वजन: *${load.weight}*\n` +
      `💰 कीमत: *₹${load.price}*\n` +
      `📅 कब: *${load.available_date}*\n\n` +
      `यह काम लेना है?\n\n` +
      `1️⃣ हाँ, मुझे यह काम चाहिए ✅\n` +
      `2️⃣ नहीं ❌`
    );
  }
  return drivers.length;
}

// =====================================
// MAIN WEBHOOK
// =====================================

app.post('/webhook', async (req, res) => {
  const from = req.body.From?.replace('whatsapp:', '');
  const message = req.body.Body?.trim();

  if (!from || !message) return res.sendStatus(200);

  const msg = message.toLowerCase().trim();

  try {

    // ─── ADMIN COMMANDS ───
    if (from === ADMIN_PHONE) {
      if (message.toUpperCase().startsWith('VERIFY ')) {
        const loadId = message.split(' ')[1]?.trim();
        const { data: load } = await supabase
          .from('loads').select('*').eq('id', loadId).single();
        const { data: driver } = await supabase
          .from('drivers').select('*').eq('phone', load.assigned_driver_phone).single();

        const certificateNo = `INS-${Date.now()}-${loadId.substring(0, 6).toUpperCase()}`;
        const insuranceDetails = calculateInsurance(load.price);

        await supabase.from('insurance_policies').insert({
          load_id: loadId,
          certificate_no: certificateNo,
          coverage_amount: insuranceDetails.coverage,
          premium_paid: insuranceDetails.totalPremium,
          your_earning: insuranceDetails.yourCut,
          transporter_phone: load.transporter_phone,
          driver_phone: load.assigned_driver_phone,
          status: 'active'
        });

        await supabase.from('loads').update({ status: 'assigned' }).eq('id', loadId);
        await supabase.from('payments').update({ status: 'verified' }).eq('load_id', loadId);

        await sendWhatsApp(load.transporter_phone,
          `✅ *Payment Verify हो गया!*\n\n` +
          `🚛 *Driver की Details:*\n` +
          `👤 नाम: ${driver.name}\n` +
          `📞 फोन: ${driver.phone}\n` +
          `⭐ Rating: ${generateStars(driver.rating)}\n\n` +
          `🛡️ *Insurance Certificate:*\n` +
          `📋 नंबर: ${certificateNo}\n` +
          `💰 Coverage: ₹${insuranceDetails.coverage.toLocaleString()}\n\n` +
          `Delivery के बाद भेजें:\n` +
          `*DELIVERED ${loadId}*`
        );

        await sendWhatsApp(driver.phone,
          `✅ *काम पक्का हो गया!*\n\n` +
          `📍 ${load.from_city} → ${load.to_city}\n` +
          `💰 आपकी कमाई: ₹${load.price}\n` +
          `📅 तारीख: ${load.available_date}\n\n` +
          `🛡️ Insurance: ${certificateNo}\n\n` +
          `📞 Transporter: ${load.transporter_phone}\n\n` +
          `सुरक्षित यात्रा करें! 🚛`
        );

        await sendWhatsApp(ADMIN_PHONE, `✅ Load ${loadId} verify हो गया।`);
        return res.sendStatus(200);
      }

      if (message.toUpperCase().startsWith('REJECT ')) {
        const loadId = message.split(' ')[1]?.trim();
        const { data: load } = await supabase
          .from('loads').select('*').eq('id', loadId).single();
        await supabase.from('loads').update({ status: 'pending_payment' }).eq('id', loadId);
        await supabase.from('payments').update({ status: 'rejected' }).eq('load_id', loadId);
        await sendWhatsApp(load.transporter_phone,
          `❌ *Payment Verify नहीं हुआ*\n\n` +
          `Transaction ID सही नहीं था।\n\n` +
          `सही Transaction ID के साथ दोबारा भेजें:\n` +
          `*PAID ${loadId} [Transaction ID]*`
        );
        return res.sendStatus(200);
      }

      if (message.toUpperCase().startsWith('DRIVER_PAID ')) {
        const loadId = message.split(' ')[1]?.trim();
        const { data: load } = await supabase
          .from('loads').select('*').eq('id', loadId).single();
        await supabase.from('loads').update({ status: 'completed' }).eq('id', loadId);
        await sendWhatsApp(load.assigned_driver_phone,
          `✅ *पैसे मिल गए!*\n\n` +
          `₹${load.price} आपके UPI में भेज दिए गए।\n\n` +
          `Transport Bot use करने के लिए धन्यवाद! 🚛`
        );
        return res.sendStatus(200);
      }
    }

    // ─── PAYMENT CONFIRMATION ───
    if (message.toUpperCase().startsWith('PAID ')) {
      const parts = message.split(' ');
      const loadId = parts[1]?.trim();
      const transactionId = parts[2]?.trim() || 'Not provided';

      const { data: load } = await supabase
        .from('loads').select('*').eq('id', loadId).single();

      if (!load || load.status !== 'pending_payment') {
        await sendWhatsApp(from, '❌ इस Load का कोई pending payment नहीं मिला।');
        return res.sendStatus(200);
      }

      await supabase.from('payments').insert({
        load_id: loadId,
        transporter_phone: from,
        transaction_id: transactionId,
        amount: COMMISSION,
        status: 'pending_verification'
      });

      await supabase.from('loads')
        .update({ status: 'payment_verification' }).eq('id', loadId);

      await sendWhatsApp(ADMIN_PHONE,
        `💰 *नया Payment Verify करना है!*\n\n` +
        `📍 Load: ${load.from_city} → ${load.to_city}\n` +
        `👤 Transporter: ${from}\n` +
        `🆔 Transaction ID: ${transactionId}\n` +
        `💵 Amount: ₹${COMMISSION}\n\n` +
        `Approve: *VERIFY ${loadId}*\n` +
        `Reject: *REJECT ${loadId}*`
      );

      await sendWhatsApp(from,
        `⏳ *Payment Check हो रहा है*\n\n` +
        `Transaction ID: ${transactionId}\n\n` +
        `30 मिनट में verify होगा।\n` +
        `Verify होते ही Driver की details मिलेगी।`
      );
      return res.sendStatus(200);
    }

    // ─── DELIVERY CONFIRMED ───
    if (message.toUpperCase().startsWith('DELIVERED ')) {
      const loadId = message.split(' ')[1]?.trim();
      const { data: load } = await supabase
        .from('loads').select('*').eq('id', loadId).single();

      if (!load || from !== load.transporter_phone) {
        await sendWhatsApp(from, '❌ यह load आपका नहीं है।');
        return res.sendStatus(200);
      }

      await supabase.from('loads').update({ status: 'delivered' }).eq('id', loadId);

      await sendWhatsApp(from,
        `✅ *Delivery Confirm हो गई!*\n\n` +
        `Driver को rate करें:\n` +
        `1️⃣ = बहुत बुरा\n` +
        `2️⃣ = बुरा\n` +
        `3️⃣ = ठीक है\n` +
        `4️⃣ = अच्छा\n` +
        `5️⃣ = बहुत अच्छा\n\n` +
        `सिर्फ भेजें: *RATE ${loadId} 5 बहुत अच्छा driver था*`
      );

      await sendWhatsApp(load.assigned_driver_phone,
        `🎉 *Delivery Confirm हो गई!*\n\n` +
        `💰 आपकी कमाई: ₹${load.price}\n\n` +
        `अपना UPI ID भेजें पैसे पाने के लिए:\n` +
        `*UPI [आपका UPI ID]*\n\n` +
        `जैसे: UPI 9876543210@paytm`
      );

      await sendWhatsApp(ADMIN_PHONE,
        `📦 *Delivery हो गई!*\n\n` +
        `Load: ${load.from_city} → ${load.to_city}\n` +
        `Driver को payment करनी है: ₹${load.price}`
      );
      return res.sendStatus(200);
    }

    // ─── DRIVER SHARES UPI ───
    if (message.toUpperCase().startsWith('UPI ')) {
      const upiId = message.split(' ')[1]?.trim();
      const { data: load } = await supabase
        .from('loads').select('*')
        .eq('assigned_driver_phone', from)
        .eq('status', 'delivered')
        .order('created_at', { ascending: false })
        .limit(1).single();

      if (!load) {
        await sendWhatsApp(from, '❌ कोई delivered load नहीं मिला।');
        return res.sendStatus(200);
      }

      await supabase.from('drivers').update({ upi_id: upiId }).eq('phone', from);

      await sendWhatsApp(from,
        `✅ UPI ID मिल गया: ${upiId}\n\n` +
        `₹${load.price} 2 घंटे में भेज दिए जाएंगे।\n` +
        `धन्यवाद! 🚛`
      );

      await sendWhatsApp(ADMIN_PHONE,
        `💸 *Driver को Payment भेजो!*\n\n` +
        `Driver: ${from}\n` +
        `UPI: ${upiId}\n` +
        `Amount: ₹${load.price}\n\n` +
        `भेजने के बाद: *DRIVER_PAID ${load.id}*`
      );
      return res.sendStatus(200);
    }

    // ─── RATING ───
    if (message.toUpperCase().startsWith('RATE ')) {
      const parts = message.split(' ');
      const loadId = parts[1]?.trim();
      const rating = parseInt(parts[2]);
      const comment = parts.slice(3).join(' ') || 'कोई comment नहीं';

      if (isNaN(rating) || rating < 1 || rating > 5) {
        await sendWhatsApp(from, `❌ Rating 1 से 5 के बीच होनी चाहिए।\nजैसे: RATE ${loadId} 5 बहुत अच्छा`);
        return res.sendStatus(200);
      }

      const { data: load } = await supabase
        .from('loads').select('*').eq('id', loadId).single();

      if (!load) {
        await sendWhatsApp(from, '❌ Load नहीं मिला।');
        return res.sendStatus(200);
      }

      const isTransporter = from === load.transporter_phone;
      const ratedPhone = isTransporter ? load.assigned_driver_phone : load.transporter_phone;

      await supabase.from('ratings').insert({
        load_id: loadId,
        rated_by: from,
        rated_by_type: isTransporter ? 'transporter' : 'driver',
        rated_phone: ratedPhone,
        rating,
        comment
      });

      const { data: allRatings } = await supabase
        .from('ratings').select('rating').eq('rated_phone', ratedPhone);
      const avgRating = allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length;

      if (isTransporter) {
        await supabase.from('drivers')
          .update({ rating: avgRating }).eq('phone', ratedPhone);
      }

      await sendWhatsApp(from,
        `⭐ *Rating दे दी!*\n\n` +
        `${'⭐'.repeat(rating)} ${rating}/5\n` +
        `Comment: "${comment}"\n\n` +
        `धन्यवाद! 🙏`
      );

      await sendWhatsApp(ratedPhone,
        `⭐ *नई Rating मिली!*\n\n` +
        `${'⭐'.repeat(rating)} ${rating}/5\n` +
        `"${comment}"\n\n` +
        `नई Average Rating: ${generateStars(avgRating)}`
      );
      return res.sendStatus(200);
    }

    // ─── INSURANCE CLAIM ───
    if (message.toUpperCase().startsWith('CLAIM ')) {
      const parts = message.split(' ');
      const certificateNo = parts[1]?.trim();
      const description = parts.slice(2).join(' ') || 'कोई description नहीं';

      const { data: policy } = await supabase
        .from('insurance_policies').select('*')
        .eq('certificate_no', certificateNo).single();

      if (!policy || (from !== policy.transporter_phone && from !== policy.driver_phone)) {
        await sendWhatsApp(from, '❌ Certificate नहीं मिला या आप इस policy में नहीं हैं।');
        return res.sendStatus(200);
      }

      const claimNo = `CLM-${Date.now()}`;
      await supabase.from('insurance_claims').insert({
        claim_no: claimNo,
        certificate_no: certificateNo,
        load_id: policy.load_id,
        claimed_by: from,
        description,
        status: 'submitted',
        coverage_amount: policy.coverage_amount
      });

      await sendWhatsApp(from,
        `🛡️ *Claim Submit हो गया!*\n\n` +
        `Claim No: ${claimNo}\n` +
        `24 घंटे में हमारी team contact करेगी।\n\n` +
        `ये documents तैयार रखें:\n` +
        `📸 नुकसान की photos\n` +
        `📄 Police report (अगर accident)\n` +
        `📋 माल की receipt`
      );

      await sendWhatsApp(ADMIN_PHONE,
        `🚨 *Insurance Claim आया!*\n\n` +
        `Claim: ${claimNo}\n` +
        `Certificate: ${certificateNo}\n` +
        `By: ${from}\n` +
        `Description: ${description}`
      );
      return res.sendStatus(200);
    }

    // =====================================
    // CONVERSATION FLOW WITH SESSIONS
    // =====================================

    let session = sessions[from] || {};

    // ─── DRIVER FLOW ───
    const { data: driverCheck } = await supabase
      .from('drivers').select('*').eq('phone', from).single();

    if (driverCheck) {
      // Driver is viewing a load and responding 1 or 2
      if (session.state === 'viewing_load') {
        if (msg === '1') {
          const loadId = session.currentLoadId;
          const { data: load } = await supabase
            .from('loads').select('*').eq('id', loadId).single();

          if (!load || load.status !== 'open') {
            await sendWhatsApp(from, '❌ माफ करें, यह load अब available नहीं है।');
            sessions[from] = {};
            return res.sendStatus(200);
          }

          await supabase.from('acceptances').insert({
            load_id: loadId,
            driver_phone: from,
            driver_name: driverCheck.name,
            payment_status: 'pending'
          });

          await supabase.from('loads')
            .update({ status: 'pending_payment', assigned_driver_phone: from })
            .eq('id', loadId);

          await sendWhatsApp(from,
            `✅ *काम Accept हो गया!*\n\n` +
            `📍 ${load.from_city} → ${load.to_city}\n` +
            `💰 आपकी कमाई: ₹${load.price}\n\n` +
            `⏳ Transporter के payment का इंतज़ार है।\n` +
            `Payment होते ही Transporter की details मिलेगी।`
          );

          const insuranceDetails = calculateInsurance(load.price);
          const totalPayable = COMMISSION + insuranceDetails.totalPremium;
          const upiLink = generateUPILink(totalPayable, loadId);

          await sendWhatsApp(load.transporter_phone,
            `✅ *Driver मिल गया!*\n\n` +
            `📍 ${load.from_city} → ${load.to_city}\n` +
            `🚛 Driver: ${driverCheck.name}\n` +
            `⭐ Rating: ${generateStars(driverCheck.rating)}\n\n` +
            `💳 *Payment करें:*\n` +
            `├ Commission: ₹${COMMISSION}\n` +
            `├ Insurance: ₹${insuranceDetails.totalPremium}\n` +
            `└ *Total: ₹${totalPayable}*\n\n` +
            `📱 UPI ID: *${UPI_ID}*\n` +
            `👤 नाम: ${UPI_NAME}\n\n` +
            `🔗 UPI Link: ${upiLink}\n\n` +
            `Payment के बाद भेजें:\n` +
            `*PAID ${loadId} [Transaction ID]*`
          );

          sessions[from] = {};
          return res.sendStatus(200);

        } else if (msg === '2') {
          sessions[from] = {};
          await sendWhatsApp(from,
            `ठीक है! 👍\n\n` +
            `जब नया load आएगा, आपको फिर notification मिलेगी।`
          );
          return res.sendStatus(200);
        }
      }

      // Driver main menu
      await sendWhatsApp(from,
        `🚛 *नमस्ते ${driverCheck.name} भाई!*\n\n` +
        `आप क्या करना चाहते हैं?\n\n` +
        `1️⃣ उपलब्ध Loads देखें\n` +
        `2️⃣ मेरा चालू काम\n` +
        `3️⃣ मेरी Rating देखें\n\n` +
        `सिर्फ 1, 2 या 3 भेजें 👆`
      );

      if (msg === '1') {
        const { data: loads } = await supabase
          .from('loads').select('*').eq('status', 'open')
          .order('created_at', { ascending: false }).limit(3);

        if (!loads || loads.length === 0) {
          await sendWhatsApp(from,
            `😔 अभी कोई load available नहीं है।\n\n` +
            `जैसे ही नया load आएगा, आपको notification मिलेगी!`
          );
        } else {
          for (const load of loads) {
            sessions[from] = { role: 'driver', state: 'viewing_load', currentLoadId: load.id };
            await sendWhatsApp(from,
              `🚛 *Load Available है!*\n\n` +
              `📍 से: *${load.from_city}*\n` +
              `🏁 तक: *${load.to_city}*\n` +
              `⚖️ वजन: *${load.weight}*\n` +
              `💰 कीमत: *₹${load.price}*\n` +
              `📅 कब: *${load.available_date}*\n\n` +
              `1️⃣ हाँ, यह काम चाहिए ✅\n` +
              `2️⃣ नहीं ❌`
            );
          }
        }
      } else if (msg === '2') {
        const { data: currentJob } = await supabase
          .from('loads').select('*')
          .eq('assigned_driver_phone', from)
          .in('status', ['assigned', 'delivered'])
          .order('created_at', { ascending: false })
          .limit(1).single();

        if (!currentJob) {
          await sendWhatsApp(from, `😔 अभी कोई चालू काम नहीं है।`);
        } else {
          await sendWhatsApp(from,
            `📦 *आपका चालू काम:*\n\n` +
            `📍 ${currentJob.from_city} → ${currentJob.to_city}\n` +
            `⚖️ ${currentJob.weight}\n` +
            `💰 ₹${currentJob.price}\n` +
            `📊 Status: ${currentJob.status}\n\n` +
            `Delivery के बाद Transporter से confirm करवाएं।`
          );
        }
      } else if (msg === '3') {
        await sendWhatsApp(from,
          `⭐ *आपकी Rating:*\n\n` +
          `${generateStars(driverCheck.rating)}\n\n` +
          `अच्छी rating के लिए:\n` +
          `✅ समय पर पहुँचें\n` +
          `✅ माल सुरक्षित पहुँचाएं\n` +
          `✅ Transporter से अच्छे से बात करें`
        );
      }

      return res.sendStatus(200);
    }

    // ─── TRANSPORTER FLOW ───
    // Check if in middle of posting a load
    if (session.state === 'asking_from') {
      sessions[from] = { ...session, from_city: message, state: 'asking_to' };
      await sendWhatsApp(from,
        `👍 *${message}* से माल जाएगा।\n\n` +
        `🏁 माल कहाँ पहुँचाना है?\n` +
        `(शहर का नाम लिखें, जैसे: Delhi, Pune, Chennai)`
      );
      return res.sendStatus(200);
    }

    if (session.state === 'asking_to') {
      sessions[from] = { ...session, to_city: message, state: 'asking_weight' };
      await sendWhatsApp(from,
        `👍 *${message}* तक पहुँचाना है।\n\n` +
        `⚖️ कितना माल है?\n` +
        `(जैसे: 5 ton, 10 ton, 500 kg)`
      );
      return res.sendStatus(200);
    }

    if (session.state === 'asking_weight') {
      sessions[from] = { ...session, weight: message, state: 'asking_price' };
      await sendWhatsApp(from,
        `👍 *${message}* माल है।\n\n` +
        `💰 कितने पैसे देंगे Driver को?\n` +
        `(सिर्फ number लिखें, जैसे: 45000)`
      );
      return res.sendStatus(200);
    }

    if (session.state === 'asking_price') {
      sessions[from] = { ...session, price: message, state: 'asking_date' };
      await sendWhatsApp(from,
        `👍 ₹*${message}* देंगे।\n\n` +
        `📅 माल कब चाहिए?\n` +
        `(जैसे: Aaj, Kal, 25 March, 1 April)`
      );
      return res.sendStatus(200);
    }

    if (session.state === 'asking_date') {
      const loadData = {
        from_city: session.from_city,
        to_city: session.to_city,
        weight: session.weight,
        price: session.price,
        available_date: message
      };

      sessions[from] = { ...session, available_date: message, state: 'confirming', loadData };

      const insuranceDetails = calculateInsurance(session.price);
      const totalPayable = COMMISSION + insuranceDetails.totalPremium;

      await sendWhatsApp(from,
        `📋 *आपका Load:*\n\n` +
        `📍 कहाँ से: *${loadData.from_city}*\n` +
        `🏁 कहाँ तक: *${loadData.to_city}*\n` +
        `⚖️ वजन: *${loadData.weight}*\n` +
        `💰 कीमत: *₹${loadData.price}*\n` +
        `📅 तारीख: *${loadData.available_date}*\n\n` +
        `🛡️ Insurance: ₹${insuranceDetails.totalPremium} (Coverage: ₹${insuranceDetails.coverage.toLocaleString()})\n` +
        `💵 Commission: ₹${COMMISSION}\n` +
        `📊 Driver मिलने पर Total: ₹${totalPayable}\n\n` +
        `क्या यह सही है?\n\n` +
        `1️⃣ हाँ, Post करो ✅\n` +
        `2️⃣ नहीं, फिर से भरो ❌`
      );
      return res.sendStatus(200);
    }

    if (session.state === 'confirming') {
      if (msg === '1') {
        const { data: newLoad } = await supabase
          .from('loads')
          .insert({
            transporter_phone: from,
            ...session.loadData,
            insurance_fee: calculateInsurance(session.loadData.price).totalPremium,
            insurance_status: 'pending'
          })
          .select().single();

        const driverCount = await notifyDrivers(newLoad);
        sessions[from] = {};

        await sendWhatsApp(from,
          `✅ *Load Post हो गया!*\n\n` +
          `📍 ${session.loadData.from_city} → ${session.loadData.to_city}\n` +
          `👥 ${driverCount} Drivers को notification गई!\n\n` +
          `जैसे ही Driver Accept करेगा, आपको message आएगा। 📱`
        );

      } else if (msg === '2') {
        sessions[from] = { state: 'asking_from' };
        await sendWhatsApp(from,
          `ठीक है! फिर से भरते हैं।\n\n` +
          `📍 माल कहाँ से जाएगा?\n` +
          `(शहर का नाम लिखें, जैसे: Mumbai, Surat)`
        );
      }
      return res.sendStatus(200);
    }

    // ─── MAIN MENU (New User or Transporter) ───
    // Show role selection if unknown user
    if (msg === 'hi' || msg === 'hello' || msg === 'helo' ||
        msg === 'हाय' || msg === 'हेलो' || msg === 'नमस्ते' ||
        msg === 'start' || msg === '0' || !session.role) {

      sessions[from] = {};
      await sendWhatsApp(from,
        `🚛 *नमस्ते! Transport Bot में आपका स्वागत है!*\n\n` +
        `आप कौन हैं?\n\n` +
        `1️⃣ मैं Transporter हूँ\n` +
        `   (माल भेजना है)\n\n` +
        `2️⃣ मैं Driver हूँ\n` +
        `   (काम चाहिए)\n\n` +
        `सिर्फ 1 या 2 भेजें 👆`
      );
      return res.sendStatus(200);
    }

    if (msg === '1' && !session.state) {
      sessions[from] = { role: 'transporter', state: 'asking_from' };
      await sendWhatsApp(from,
        `👍 *Transporter Menu*\n\n` +
        `चलिए Load post करते हैं!\n\n` +
        `📍 माल कहाँ से जाएगा?\n` +
        `(शहर का नाम लिखें, जैसे: Mumbai, Surat, Pune)`
      );
      return res.sendStatus(200);
    }

    if (msg === '2' && !session.state) {
      sessions[from] = { role: 'driver' };
      await sendWhatsApp(from,
        `🚛 *Driver Menu*\n\n` +
        `आप registered नहीं हैं।\n\n` +
        `Register होने के लिए Admin से contact करें:\n` +
        `📞 ${ADMIN_PHONE}\n\n` +
        `Register होने के बाद automatically loads मिलेंगे!`
      );
      return res.sendStatus(200);
    }

    // Default fallback
    await sendWhatsApp(from,
      `🚛 *Transport Bot*\n\n` +
      `शुरू करने के लिए भेजें: *Hi*\n\n` +
      `या कोई भी message भेजें।`
    );

  } catch (error) {
    console.error('Error:', error);
    await sendWhatsApp(from,
      `😔 कुछ गलत हो गया। थोड़ी देर बाद try करें।\n` +
      `या Admin से contact करें: ${ADMIN_PHONE}`
    );
  }

  res.sendStatus(200);
});

// =====================================
// API ENDPOINTS
// =====================================

app.post('/register-driver', async (req, res) => {
  const { name, phone, from_city, to_city, truck_capacity } = req.body;
  const { data, error } = await supabase.from('drivers')
    .insert({ name, phone, from_city, to_city, truck_capacity })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, driver: data });
});

app.get('/loads', async (req, res) => {
  const { data } = await supabase.from('loads')
    .select('*').order('created_at', { ascending: false });
  res.json(data);
});

app.get('/drivers', async (req, res) => {
  const { data } = await supabase.from('drivers').select('*');
  res.json(data);
});

app.get('/payments', async (req, res) => {
  const { data } = await supabase.from('payments')
    .select('*').order('created_at', { ascending: false });
  res.json(data);
});

app.get('/', (req, res) => res.send('Transport Bot India is running! 🚛'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
