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
        .from('ratings').select('rating').eq('rated
