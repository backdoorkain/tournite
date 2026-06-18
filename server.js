const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Configuración de la Base de Datos SQLite (Con ruta persistente para Render)
const db = new sqlite3.Database('/data/torneo.db', (req, res) => {
    console.log('Conectado a la base de datos SQLite.');
});

// Crear tabla adaptada con monto_pago para simulaciones
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        epic_id TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        pagado INTEGER DEFAULT 0,
        monto_pago REAL DEFAULT 0.00,
        es_admin INTEGER DEFAULT 0,
        p1_pos INTEGER DEFAULT 0,
        p2_pos INTEGER DEFAULT 0,
        p3_pos INTEGER DEFAULT 0,
        puntos_totales INTEGER DEFAULT 0
    )`);
    
    db.run(`INSERT OR IGNORE INTO usuarios (epic_id, password, es_admin, pagado) 
            VALUES ('admin', 'admin123', 1, 1)`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 2. Busca tu bloque app.use(session(...)) viejo y reemplázalo por este:
app.use(session({
    store: new SQLiteStore({ 
        db: 'sesiones.db', 
        dir: '/data' // <--- Asegúrate de que diga '/data' si usas el disco de Render, o '.' si estás en pruebas locales
    }),
    secret: 'secreto-torneo-fortnite-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

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
app.post('/api/registrar', (req, res) => {
    const { epic_id, password } = req.body;
    if (!epic_id || !password) return res.status(400).json({ error: "Campos incompletos" });
    if (TORNEO_ESTADO !== "ABIERTO") return res.status(400).json({ error: "Inscripciones cerradas." });

    db.get(`SELECT COUNT(*) as total FROM usuarios WHERE pagado = 1 AND es_admin = 0`, [], (err, row) => {
        if (row.total >= LIMITE_JUGADORES) return res.status(400).json({ error: "Torneo lleno." });

        db.run(`INSERT INTO usuarios (epic_id, password) VALUES (?, ?)`, [epic_id, password], function(err) {
            if (err) return res.status(400).json({ error: "El ID ya existe." });
            req.session.user = { epic_id, pagado: 0, es_admin: 0 };
            res.json({ success: true, redirect: '/checkout.html' });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { epic_id, password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE epic_id = ? AND password = ?`, [epic_id, password], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Credenciales incorrectas" });
        req.session.user = { epic_id: row.epic_id, pagado: row.pagado, es_admin: row.es_admin };
        if (row.es_admin === 1) return res.json({ success: true, redirect: '/admin.html' });
        if (row.pagado === 1) return res.json({ success: true, redirect: '/portal.html' });
        res.json({ success: true, redirect: '/checkout.html' });
    });
});

// --- STRIPE INTEGRADO CON MONTO REAL ---
app.post('/create-checkout-session', async (req, res) => {
  //if (!req.session.user) return res.status(401).json({ error: "Inicia sesión" });
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            client_reference_id: req.session.user.epic_id,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Inscripción Torneo' },
                    unit_amount: 500,
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
            // Guardamos el pago real de 5.00 dólares en la BD
            db.run(`UPDATE usuarios SET pagado = 1, monto_pago = 5.00 WHERE epic_id = ?`, [epic_id], () => {
                if (req.session.user && req.session.user.epic_id === epic_id) req.session.user.pagado = 1;
                res.redirect('/portal.html');
            });
        } else { res.redirect('/checkout.html?error=no_paid'); }
    } catch (error) { res.redirect('/checkout.html?error=error'); }
});

// --- PORTAL PÚBLICO DEL JUGADOR ---
app.get('/api/torneo-data', (req, res) => {
    if (!req.session.user || req.session.user.pagado !== 1) return res.status(403).json({ error: "No autorizado" });

    db.all(`SELECT epic_id, puntos_totales, p1_pos, p2_pos, p3_pos FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // Sumamos dinámicamente la columna monto_pago de todos los registrados para la bolsa acumulada
        db.get(`SELECT SUM(monto_pago) as bolsa, COUNT(*) as creados FROM usuarios WHERE pagado = 1 AND es_admin = 0`, [], (err, totalRow) => {
            const registrados = totalRow.creados || 0;
            const bolsaTotal = totalRow.bolsa || 0;

            res.json({
                usuarioActual: req.session.user.epic_id,
                tabla: rows,
                contadorCupos: `${registrados}/${LIMITE_JUGADORES}`,
                bolsaTotal: bolsaTotal.toFixed(2),
                clave: CLAVE_PARTIDA,
                estadoTorneo: TORNEO_ESTADO
            });
        });
    });
});

// --- PANEL DE CONTROL ADMINISTRADOR ---
app.get('/api/admin/status', (req, res) => {
    if (!req.session.user || req.session.user.es_admin !== 1) return res.status(403).json({ error: "No admin" });
    db.all(`SELECT epic_id, p1_pos, p2_pos, p3_pos, puntos_totales, monto_pago FROM usuarios WHERE pagado = 1 AND es_admin = 0 ORDER BY puntos_totales DESC`, [], (err, rows) => {
        res.json({ limite: LIMITE_JUGADORES, estado: TORNEO_ESTADO, clave: CLAVE_PARTIDA, jugadores: rows });
    });
});

app.post('/api/admin/configurar', (req, res) => {
    if (!req.session.user || req.session.user.es_admin !== 1) return res.status(403).json({ error: "No admin" });
    const { limite, estado, clave } = req.body;
    if (limite) LIMITE_JUGADORES = parseInt(limite);
    if (estado) TORNEO_ESTADO = estado; 
    if (clave) CLAVE_PARTIDA = clave;
    res.json({ success: true });
});

// NUEVO: Inyectar jugador ficticio con monto personalizado
app.post('/api/admin/inyectar-jugador', (req, res) => {
    if (!req.session.user || req.session.user.es_admin !== 1) return res.status(403).json({ error: "No admin" });
    const { epic_id, monto } = req.body;
    if (!epic_id) return res.status(400).json({ error: "Falta ID" });

    const montoNum = parseFloat(monto) || 0.00;

    db.run(`INSERT OR REPLACE INTO usuarios (epic_id, password, pagado, monto_pago) VALUES (?, 'bot123', 1, ?)`, 
        [epic_id, montoNum], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
    });
});

app.post('/api/admin/actualizar-puntos', (req, res) => {
    if (!req.session.user || req.session.user.es_admin !== 1) return res.status(403).json({ error: "No admin" });
    const { epic_id, p1_pos, p2_pos, p3_pos } = req.body;
    const p1 = parseInt(p1_pos) || 0; const p2 = parseInt(p2_pos) || 0; const p3 = parseInt(p3_pos) || 0;

    const puntosTotales = calcularPuntosPorPosicion(p1) + calcularPuntosPorPosicion(p2) + calcularPuntosPorPosicion(p3);

    db.run(`UPDATE usuarios SET p1_pos = ?, p2_pos = ?, p3_pos = ?, puntos_totales = ? WHERE epic_id = ?`,
        [p1, p2, p3, puntosTotales, epic_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
    });
});

app.post('/api/admin/reset-todo', (req, res) => {
    if (!req.session.user || req.session.user.es_admin !== 1) return res.status(403).json({ error: "No admin" });
    db.run(`DELETE FROM usuarios WHERE es_admin = 0`, [], (err) => {
        CLAVE_PARTIDA = "CERRADO"; TORNEO_ESTADO = "CERRADO";
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de pruebas listo.`));
