const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connection String PostgreSQL (dari Supabase / Environment Variable)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Auto-create database tables
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50),
        address TEXT,
        tax_id VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        code VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        cost_price NUMERIC(10, 2) DEFAULT 0,
        selling_price NUMERIC(10, 2) DEFAULT 0,
        stock_qty INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL, -- 'INVOICE' atau 'QUOTATION'
        doc_number VARCHAR(100) UNIQUE NOT NULL,
        customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
        date DATE,
        due_date DATE,
        status VARCHAR(50),
        sub_total NUMERIC(10, 2),
        tax_amount NUMERIC(10, 2),
        discount_amount NUMERIC(10, 2),
        grand_total NUMERIC(10, 2),
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS document_items (
        id SERIAL PRIMARY KEY,
        document_id INT REFERENCES documents(id) ON DELETE CASCADE,
        item_code VARCHAR(100),
        description TEXT,
        quantity INT,
        unit_price NUMERIC(10, 2),
        total NUMERIC(10, 2)
      );
    `);
    console.log("Database tables checked & ready.");
  } catch (err) {
    console.error("Database connection error:", err);
  }
}

initDb();

// ================= API ENDPOINTS =================

// CUSTOMERS API
app.get('/api/customers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  const { name, email, phone, address, tax_id } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO customers (name, email, phone, address, tax_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, email, phone, address, tax_id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INVENTORY API
app.get('/api/inventory', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory', async (req, res) => {
  const { code, name, category, cost_price, selling_price, stock_qty } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO inventory (code, name, category, cost_price, selling_price, stock_qty)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [code, name, category, cost_price || 0, selling_price || 0, stock_qty || 0]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DOCUMENTS API (INVOICES & QUOTATIONS)
app.get('/api/documents/:type', async (req, res) => {
  const type = req.params.type.toUpperCase();
  try {
    const docsRes = await pool.query(
      `SELECT d.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone 
       FROM documents d 
       LEFT JOIN customers c ON d.customer_id = c.id 
       WHERE d.type = $1 ORDER BY d.id DESC`,
      [type]
    );

    const docs = docsRes.rows;
    for (let doc of docs) {
      const itemsRes = await pool.query('SELECT * FROM document_items WHERE document_id = $1', [doc.id]);
      doc.items = itemsRes.rows;
    }

    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { type, doc_number, customer_id, date, due_date, status, sub_total, tax_amount, discount_amount, grand_total, notes, items } = req.body;

    const docRes = await client.query(
      `INSERT INTO documents (type, doc_number, customer_id, date, due_date, status, sub_total, tax_amount, discount_amount, grand_total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [type, doc_number, customer_id, date, due_date, status, sub_total, tax_amount, discount_amount, grand_total, notes]
    );

    const docId = docRes.rows[0].id;

    if (items && items.length > 0) {
      for (let item of items) {
        await client.query(
          `INSERT INTO document_items (document_id, item_code, description, quantity, unit_price, total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [docId, item.item_code, item.description, item.quantity, item.unit_price, item.total]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, id: docId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single Page Application Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MFZ Invoice System berjalan pada port ${PORT}`);
});