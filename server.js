const express = require('express');
const session = require('express-session');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
        epic_id TEXT PRIMARY KEY, password TEXT NOT NULL, pagado INTEGER DEFAULT 0,
        monto_pago REAL DEFAULT 0.00, es_admin INTEGER DEFAULT 0,
        p1_pos INTEGER DEFAULT 0, p2_pos INTEGER DEFAULT 0, p3_pos INTEGER DEFAULT 0,
        puntos_totales INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default", "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL, CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    ) WITH (OIDS=FALSE);
`, (err) => {
    if (err) console.error("Error tablas:", err.message);
    else {
        console.log("Conectado a Neon. Tablas OK.");
        pool.query(`INSERT INTO usuarios (epic_id, password, es_admin, pagado) VALUES ('admin', 'admin123', 1, 1) ON CONFLICT (epic_id) DO NOTHING`);
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
    secret: 'secreto-torneo-fortnite-2026', resave: false, saveUninitialized: false, cookie: { secure: false }
}));

let CLAVE_PARTIDA = "tournite2026x1";
let LIMITE_JUGADORES = 20;       
let TORNEO_ESTADO = "CERRADO";   // Puede ser: "CERRADO", "ABIERTO" o "EN CURSO"
let CONTADOR_FIN_MS = null;      // Guarda la hora exacta en la que termina la cuenta regresiva  

function calcPts(posicion) {
    const pos = parseInt(posicion) || 0;
    if (pos === 1) return 15; if (pos === 2) return 12; if (pos === 3) return 10;
    if (pos >= 4 && pos <= 5) return 7; if (pos >= 6 && pos <= 10) return 4;
    if (pos >= 11 && pos <= 20) return 1; return 0;
}

app.post('/api/registrar', async (req, res) => {
    const { epic_id, password } = req.body;
    if (TORNEO_ESTADO !== "ABIERTO") return res.status(400).json({ error: "Inscripciones cerradas." });
    try {
        const totalRes = await pool.query(`SELECT COUNT(*) as total FROM usuarios WHERE pagado = 1 AND es_admin = 0`);
        if (parseInt(totalRes.rows[0].total) >= LIMITE_JUGADORES) return res.status(400).json({ error: "Torneo lleno." });
        await pool.query(`INSERT INTO usuarios (epic_id, password) VALUES ($1, $2)`, [epic_id, password]);
        req.session.user = { epic_id, pagado: 0, es_admin: 0 };
        res.json({ success: true, redirect: '/checkout.html' });
    } catch (err) { res.status(400).json({ error: "El ID ya está registrado." }); }
});

app.post('/api/login', async (req, res) => {
    const { epic_id, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM usuarios WHERE epic_id = $1 AND password = $2`, [epic_id, password]);
        if (result.rows.length === 0) return res.status(400).json({ error: "Credenciales incorrectas" });
        const row = result.rows[0];
        req.session.user = { epic_id: row.epic_id, pagado: row.pagado, es_admin: row.es_admin };
        res.json({ success: true, redirect: row.es_admin === 1 ? '/admin.html' : (row.pagado === 1 ? '/portal.html' : '/checkout.html') });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/create-checkout-session', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Inicia sesión" });
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'], client_reference_id: req.session.user.epic_id,
            line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Inscripción Torneo' }, unit_amount: 860 }, quantity: 1 }],
            mode: 'payment', success_url: `${process.env.YOUR_DOMAIN}/verify-session?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${process.env.YOUR_DOMAIN}/checkout.html`,
        });
        res.json({ url: session.url });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// BUSCA Y REEMPLAZA ESTE ENDPOINT EN TU SERVER.JS:
app.get('/verify-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
        if (session.payment_status === 'paid') {
            const epic_id = session.client_reference_id;
            
            // CORRECCIÓN POSTGRES EN LA NUBE:
            // Forzamos el valor de 8.60 como un número decimal flotante real en el arreglo
            const montoDecimal = parseFloat(8.60);
            
            await pool.query(
                `UPDATE usuarios SET pagado = 1, monto_pago = $1 WHERE epic_id = $2`, 
                [montoDecimal, epic_id]
            );

            // Si el jugador actual es el que pagó, actualizamos su sesión en vivo
            if (req.session.user && req.session.user.epic_id === epic_id) {
                req.session.user.pagado = 1;
            }
            
            console.log(`💰 ¡PAGO CONFIRMADO! Usuario real detectado: ${epic_id}. Registrados $8.60 USD.`);
            res.redirect('/portal.html');
        } else { 
            res.redirect('/checkout.html?error=no_paid'); 
        }
    } catch (error) { 
        console.error("❌ Error crítico validando pago real en Neon:", error.message);
        res.redirect('/checkout.html?error=error'); 
    }
});

app.get('/api/torneo-data', async (req, res) => {
    if (!req.session.user || req.session.user.pagado !== 1) return res.status(403).json({ error: "No autorizado" });
    try {
        const tRes = await pool.query(`SELECT epic_id, puntos_totales, p1_pos, p2_pos, p3_pos FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`);
        const totalRow = await pool.query(`SELECT SUM(monto_pago) as bolsa, COUNT(*) as creados FROM usuarios WHERE pagado = 1 AND es_admin = 0`);
        const reg = parseInt(totalRow.rows.creados) || 0;
        const bLimpia = parseFloat(totalRow.rows.bolsa) || 0;

        // Calcular tiempo restante del contador de 15 minutos
        let tiempoRestanteMs = 0;
        if (CONTADOR_FIN_MS) {
            tiempoRestanteMs = Math.max(0, CONTADOR_FIN_MS - Date.now());
        }

        // REGLA: Ocultar clave y revelar solo cuando falten 5 minutos (300,000 ms) o si ya inició
        let claveRevelada = "••••••••••••••";
        if (tiempoRestanteMs > 0 && tiempoRestanteMs <= 300000) {
            claveRevelada = CLAVE_PARTIDA;
        } else if (CONTADOR_FIN_MS && tiempoRestanteMs === 0) {
            claveRevelada = CLAVE_PARTIDA; // Si el contador llegó a 0, la clave se queda visible
        }

        res.json({
            usuarioActual: req.session.user.epic_id,
            tabla: tRes.rows,
            contadorCupos: `${reg}/${LIMITE_JUGADORES}`,
            premio1st: (bLimpia * 0.40).toFixed(2),
            premio2nd: (bLimpia * 0.20).toFixed(2),
            premio3rd: (bLimpia * 0.10).toFixed(2),
            pozoVisible: (bLimpia * 0.70).toFixed(2),
            clave: claveRevelada,
            estadoTorneo: TORNEO_ESTADO,
            tiempoRestante: tiempoRestanteMs // Enviamos el reloj al frontend
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/status', async (req, res) => {
    try {
        const result = await pool.query(`SELECT epic_id, p1_pos, p2_pos, p3_pos, puntos_totales, monto_pago FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`);
        res.json({ limite: LIMITE_JUGADORES, estado: TORNEO_ESTADO, clave: CLAVE_PARTIDA, jugadores: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/configurar', (req, res) => {
    const { limite, estado, clave } = req.body;
    if (limite) LIMITE_JUGADORES = parseInt(limite);
    if (estado) TORNEO_ESTADO = estado; if (clave) CLAVE_PARTIDA = clave;
    res.json({ success: true });
});

app.post('/api/admin/inyectar-jugador', async (req, res) => {
    const { epic_id, monto, password } = req.body;
    if (!epic_id) return res.status(400).json({ error: "Falta ID" });
    try {
        await pool.query(`INSERT INTO usuarios (epic_id, password, pagado, monto_pago) VALUES ($1, $2, 1, $3) ON CONFLICT (epic_id) DO UPDATE SET pagado = 1, monto_pago = $3, password = $2`, [epic_id, password || "bot123", parseFloat(monto) || 0.00]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/eliminar-jugador', async (req, res) => {
    const { epic_id } = req.body;
    try {
        await pool.query(`DELETE FROM usuarios WHERE epic_id = $1 AND es_admin = 0`, [epic_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/actualizar-puntos', async (req, res) => {
    const { epic_id, p1_pos, p2_pos, p3_pos } = req.body;
    const p1 = parseInt(p1_pos) || 0; const p2 = parseInt(p2_pos) || 0; const p3 = parseInt(p3_pos) || 0;
    const tot = calcPts(p1) + calcPts(p2) + calcPts(p3);
    try {
        await pool.query(`UPDATE usuarios SET p1_pos = $1, p2_pos = $2, p3_pos = $3, puntos_totales = $4 WHERE epic_id = $5`, [p1, p2, p3, tot, epic_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-todo', async (req, res) => {
    try {
        await pool.query(`DELETE FROM usuarios WHERE es_admin = 0`); await pool.query(`DELETE FROM "session"`);
        CLAVE_PARTIDA = "CERRADO"; TORNEO_ESTADO = "CERRADO"; res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// BUSCA Y REEMPLAZA ESTE ENDPOINT EN TU SERVER.JS:
app.post('/api/admin/iniciar-contador', async (req, res) => {
    // Eliminamos bloqueos de sesión temporales para garantizar que el botón responda siempre
    try {
        // 1. Forzamos el cambio de estado global en el servidor
        TORNEO_ESTADO = "EN CURSO";
        
        // 2. Establecemos con exactitud matemática el segundero de 15 minutos hacia el futuro
        CONTADOR_FIN_MS = Date.now() + (15 * 60 * 1000); 
        
        console.log("⚡ Cronómetro detonado con éxito. El torneo inicia en 15 minutos.");
        res.json({ success: true, finMs: CONTADOR_FIN_MS });
    } catch (err) {
        res.status(500).json({ error: "Error interno al encender el reloj" });
    }
});

// Endpoint para que el panel de administración lea el estado actual del reloj
app.get('/api/admin/contador-status', (req, res) => {
    let tiempoRestanteMs = 0;
    if (CONTADOR_FIN_MS) {
        tiempoRestanteMs = Math.max(0, CONTADOR_FIN_MS - Date.now());
    }
    res.json({ tiempoRestante: tiempoRestanteMs, estado: TORNEO_ESTADO });
});

app.listen(process.env.PORT || 3000, () => console.log(`Servidor completo activo.`));
