const express = require('express');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// Parse load message using Claude AI
async function parseLoadMessage(message) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Extract load details from this message and return ONLY a JSON object with these fields: from_city, to_city, weight, price, available_date. If any field is missing, use "Not specified". Message: "${message}"`
    }]
  });
  
  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Send WhatsApp message
async function sendWhatsApp(to, message) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${to}`,
    body: message
  });
}

// Notify all available drivers
async function notifyDrivers(load) {
  const { data: drivers } = await supabase
    .from('drivers')
    .select('*')
    .eq('is_available', true);

  if (!drivers || drivers.length === 0) return;

  const message = `🚛 *New Load Available!*\n\n📍 From: ${load.from_city}\n🏁 To: ${load.to_city}\n⚖️ Weight: ${load.weight}\n💰 Price: ${load.price}\n📅 Date: ${load.available_date}\n🆔 Load ID: ${load.id}\n\nReply *ACCEPT ${load.id}* to confirm this job!`;

  for (const driver of drivers) {
    await sendWhatsApp(driver.phone, message);
  }
}

// Main webhook - receives all WhatsApp messages
app.post('/webhook', async (req, res) => {
  const from = req.body.From?.replace('whatsapp:', '');
  const message = req.body.Body?.trim();

  if (!from || !message) return res.sendStatus(200);

  try {
    // Check if driver is accepting a job
    if (message.toUpperCase().startsWith('ACCEPT')) {
      const loadId = message.split(' ')[1];

      // Get load details
      const { data: load } = await supabase
        .from('loads')
        .select('*')
        .eq('id', loadId)
        .single();

      if (!load || load.status !== 'open') {
        await sendWhatsApp(from, '❌ Sorry, this load is no longer available.');
        return res.sendStatus(200);
      }

      // Get driver details
      const { data: driver } = await supabase
        .from('drivers')
        .select('*')
        .eq('phone', from)
        .single();

      if (!driver) {
        await sendWhatsApp(from, '❌ You are not registered as a driver. Please contact admin.');
        return res.sendStatus(200);
      }

      // Save acceptance
      await supabase.from('acceptances').insert({
        load_id: loadId,
        driver_phone: from,
        driver_name: driver.name
      });

      // Update load status
      await supabase.from('loads').update({ status: 'assigned' }).eq('id', loadId);

      await sendWhatsApp(from, `✅ *Job Confirmed!*\n\nYou have accepted the load from ${load.from_city} to ${load.to_city}.\n💰 Price: ${load.price}\n📅 Date: ${load.available_date}\n\nSafe journey! 🚛`);

      // Notify transporter
      await sendWhatsApp(load.transporter_phone, `✅ *Load Assigned!*\n\nYour load from ${load.from_city} to ${load.to_city} has been accepted by driver ${driver.name}.\n📞 Driver Contact: ${from}`);

      return res.sendStatus(200);
    }

    // Check if this is a transporter posting a load
    if (message.toLowerCase().includes('load') || message.toLowerCase().includes('from')) {
      const loadDetails = await parseLoadMessage(message);

      // Save load to database
      const { data: newLoad } = await supabase
        .from('loads')
        .insert({
          transporter_phone: from,
          ...loadDetails
        })
        .select()
        .single();

      await sendWhatsApp(from, `✅ *Load Posted Successfully!*\n\n📍 From: ${loadDetails.from_city}\n🏁 To: ${loadDetails.to_city}\n⚖️ Weight: ${loadDetails.weight}\n💰 Price: ${loadDetails.price}\n📅 Date: ${loadDetails.available_date}\n\nNotifying available drivers now...`);

      // Notify all drivers
      await notifyDrivers(newLoad);

      return res.sendStatus(200);
    }

    // Default response
    await sendWhatsApp(from, `👋 Welcome to Transport Bot!\n\n*Transporters:* Send load details like:\n"Load from Karachi to Lahore, 5 tons, Rs 45000, 25 March"\n\n*Drivers:* Reply ACCEPT [Load ID] to accept a job.`);

  } catch (error) {
    console.error('Error:', error);
  }

  res.sendStatus(200);
});

// Register a driver
app.post('/register-driver', async (req, res) => {
  const { name, phone, from_city, to_city, truck_capacity } = req.body;
  const { data, error } = await supabase.from('drivers').insert({
    name, phone, from_city, to_city, truck_capacity
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, driver: data });
});

// Get all loads
app.get('/loads', async (req, res) => {
  const { data } = await supabase.from('loads').select('*').order('created_at', { ascending: false });
  res.json(data);
});

// Get all drivers
app.get('/drivers', async (req, res) => {
  const { data } = await supabase.from('drivers').select('*');
  res.json(data);
});

// Health check
app.get('/', (req, res) => res.send('Transport Bot is running! 🚛'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
