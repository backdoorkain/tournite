const express = require('express');
const app = express();
const path = require('path');

// Inicializa Stripe con tu Clave Secreta desde las variables de entorno
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CLAVE DE TU PARTIDA PERSONALIZADA (En producción, usa variables de entorno)
const CLAVE_FORTNITE = "TORNEO_PRO_2026"; 

// Endpoint 1: Crea la sesión de pago en Stripe
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Inscripción al Torneo de Fortnite',
              description: 'Acceso exclusivo a la partida privada y tabla de posiciones.',
            },
            unit_amount: 500, // $5.00 USD
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      // success_url y cancel_url se mantienen igual
      success_url: `${process.env.YOUR_DOMAIN}/payment.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.YOUR_DOMAIN}/index.html`,
    });

    // CAMBIO IMPORTANTE: Enviamos la URL directa de la pasarela de Stripe
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint 2: Verifica si la sesión fue pagada con éxito antes de soltar la clave
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ error: "Falta el ID de sesión" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    
    if (session.payment_status === 'paid') {
      // Si pagó con éxito, le entregamos la clave real de Fortnite
      res.json({ success: true, clave: CLAVE_FORTNITE });
    } else {
      res.json({ success: false, message: "El pago no ha sido completado." });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
