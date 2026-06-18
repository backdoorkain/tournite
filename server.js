const express = require('express');
const session = require('express-session');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();

// Conexión con Neon.tech en la nube mediante IPv4
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicializar tablas compatibles con Postgres
pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
        epic_id TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        pagado INTEGER DEFAULT 0,
        monto_pago REAL DEFAULT 0.00,
        es_admin INTEGER DEFAULT 0,
        p1_pos INTEGER DEFAULT 0,
        p2_pos INTEGER DEFAULT 0,
        p3_pos INTEGER DEFAULT 0,
        puntos_totales INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    ) WITH (OIDS=FALSE);
`, (err, res) => {
    if (err) {
        console.error("Error inicializando tablas en Neon:", err.message);
    } else {
        console.log("Conectado a la nube de Neon. Tablas validadas.");
        // Insertar administrador maestro por defecto
        pool.query(`INSERT INTO usuarios (epic_id, password, es_admin, pagado) 
                    VALUES ('admin', 'admin123', 1, 1) ON CONFLICT (epic_id) DO NOTHING`);
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: 'secreto-torneo-fortnite-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// VARIABLES DINÁMICAS GLOBALES EN MEMORIA
let CLAVE_PARTIDA = "CERRADO";
let LIMITE_JUGADORES = 20;       
let TORNEO_ESTADO = "CERRADO";   

function calcularPuntosPorPosicion(posicion) {
    const pos = parseInt(posicion) || 0;
    if (pos === 1) return 15;
    if (pos === 2) return 12;
    if (pos === 3) return 10;
    if (pos >= 4 && pos <= 5) return 7;
    if (pos >= 6 && pos <= 10) return 4;
    if (pos >= 11 && pos <= 20) return 1;
    return 0;
}

// --- ENDPOINTS DE AUTENTICACIÓN ---
app.post('/api/registrar', async (req, res) => {
    const { epic_id, password } = req.body;
    if (!epic_id || !password) return res.status(400).json({ error: "Campos incompletos" });
    if (TORNEO_ESTADO !== "ABIERTO") return res.status(400).json({ error: "Inscripciones cerradas." });

    try {
        const totalRes = await pool.query(`SELECT COUNT(*) as total FROM usuarios WHERE pagado = 1 AND es_admin = 0`);
        const total = parseInt(totalRes.rows[0].total) || 0;
        if (total >= LIMITE_JUGADORES) return res.status(400).json({ error: "Torneo lleno." });

        await pool.query(`INSERT INTO usuarios (epic_id, password) VALUES ($1, $2)`, [epic_id, password]);
        req.session.user = { epic_id, pagado: 0, es_admin: 0 };
        res.json({ success: true, redirect: '/checkout.html' });
    } catch (err) {
        res.status(400).json({ error: "El ID de Epic ya está registrado." });
    }
});

app.post('/api/login', async (req, res) => {
    const { epic_id, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM usuarios WHERE epic_id = $1 AND password = $2`, [epic_id, password]);
        if (result.rows.length === 0) return res.status(400).json({ error: "Credenciales incorrectas" });
        
        const row = result.rows[0];
        req.session.user = { epic_id: row.epic_id, pagado: row.pagado, es_admin: row.es_admin };
        
        if (row.es_admin === 1) return res.json({ success: true, redirect: '/admin.html' });
        if (row.pagado === 1) return res.json({ success: true, redirect: '/portal.html' });
        res.json({ success: true, redirect: '/checkout.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// --- PASARELA DE PAGOS DE STRIPE (AJUSTADA A $8.60 USD) ---
app.post('/create-checkout-session', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Inicia sesión" });
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            client_reference_id: req.session.user.epic_id,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Inscripción Torneo Fortnite Pro' },
                    unit_amount: 860, // Cobro exacto de $8.60 USD
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.YOUR_DOMAIN}/verify-session?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.YOUR_DOMAIN}/checkout.html`,
        });
        res.json({ url: session.url });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/verify-session', async (req, res) => {
    const { session_id } = req.query;
    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status === 'paid') {
            const epic_id = session.client_reference_id;
            // Al pagar $8.60 brutos, fijamos la bolsa limpia en exactamente $8.00 USD netos
            await pool.query(`UPDATE usuarios SET pagado = 1, monto_pago = 8.00 WHERE epic_id = $1`, [epic_id]);
            if (req.session.user && req.session.user.epic_id === epic_id) req.session.user.pagado = 1;
            res.redirect('/portal.html');
        } else { res.redirect('/checkout.html?error=no_paid'); }
    } catch (error) { res.redirect('/checkout.html?error=error'); }
});

// --- PORTAL DINÁMICO DEL JUGADOR ---
app.get('/api/torneo-data', async (req, res) => {
    if (!req.session.user || req.session.user.pagado !== 1) return res.status(403).json({ error: "No autorizado" });

    try {
        const tablaRes = await pool.query(`SELECT epic_id, puntos_totales, p1_pos, p2_pos, p3_pos FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`);
        const totalRow = await pool.query(`SELECT SUM(monto_pago) as bolsa, COUNT(*) as creados FROM usuarios WHERE pagado = 1 AND es_admin = 0`);
        
        const registrados = parseInt(totalRow.rows[0].creados) || 0;
        const bolsaLimpia = parseFloat(totalRow.rows[0].bolsa) || 0;

        // Distribución matemática exacta (40% / 20% / 10%) sobre el dinero neto
        const premio1 = bolsaLimpia * 0.40;
        const premio2 = bolsaLimpia * 0.20;
        const premio3 = bolsaLimpia * 0.10;
        const pozoParaPremios = premio1 + premio2 + premio3; // Equivale al 70% visible

        res.json({
            usuarioActual: req.session.user.epic_id,
            tabla: tablaRes.rows,
            contadorCupos: `${registrados}/${LIMITE_JUGADORES}`,
            premio1st: premio1.toFixed(2),
            premio2nd: premio2.toFixed(2),
            premio3rd: premio3.toFixed(2),
            pozoVisible: pozoParaPremios.toFixed(2),
            clave: CLAVE_PARTIDA,
            estadoTorneo: TORNEO_ESTADO
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PANEL DE CONTROL ADMINISTRADOR ---
app.get('/api/admin/status', async (req, res) => {
    try {
        const result = await pool.query(`SELECT epic_id, p1_pos, p2_pos, p3_pos, puntos_totales, monto_pago FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`);
        res.json({ limite: LIMITE_JUGADORES, estado: TORNEO_ESTADO, clave: CLAVE_PARTIDA, jugadores: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/configurar', (req, res) => {
    const { limite, estado, clave } = req.body;
    if (limite) LIMITE_JUGADORES = parseInt(limite);
    if (estado) TORNEO_ESTADO = estado; 
    if (clave) CLAVE_PARTIDA = clave;
    res.json({ success: true });
});

app.post('/api/admin/inyectar-jugador', async (req, res) => {
    const { epic_id, monto } = req.body;
    if (!epic_id) return res.status(400).json({ error: "Falta ID" });
    const montoNum = parseFloat(monto) || 0.00;

    try {
        await pool.query(`
            INSERT INTO usuarios (epic_id, password, pagado, monto_pago) 
            VALUES ($1, 'bot123', 1, $2) 
            ON CONFLICT (epic_id) DO UPDATE SET pagado = 1, monto_pago = $2
        `, [epic_id, montoNum]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/actualizar-puntos', async (req, res) => {
    const { epic_id, p1_pos, p2_pos, p3_pos } = req.body;
    const p1 = parseInt(p1_pos) || 0; const p2 = parseInt(p2_pos) || 0; const p3 = parseInt(p3_pos) || 0;
    const puntosTotales = calcularPuntosPorPosicion(p1) + calcularPuntosPorPosicion(p2) + calcularPuntosPorPosicion(p3);

    try {
        await pool.query(`UPDATE usuarios SET p1_pos = $1, p2_pos = $2, p3_pos = $3, puntos_totales = $4 WHERE epic_id = $5`, [p1, p2, p3, puntosTotales, epic_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-todo', async (req, res) => {
    try {
        await pool.query(`DELETE FROM usuarios WHERE es_admin = 0`);
        await pool.query(`DELETE FROM "session"`);
        CLAVE_PARTIDA = "CERRADO"; TORNEO_ESTADO = "CERRADO";
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de torneo Postgres activo.`));
