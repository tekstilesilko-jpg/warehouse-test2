import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Decimal } from 'decimal.js';

type Role = 'WAREHOUSE' | 'SALES' | 'ADMIN';

interface Env {
  WAREHOUSE_DB: D1Database;
  ENVIRONMENT?: string;
}

type Variables = {
  user: {
    id: number;
    email: string;
    displayName: string;
    role: Role;
    language: 'lt' | 'en';
  };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('/api/*', cors());

function decimal(v: string | number | null | undefined): Decimal {
  try {
    if (v === null || v === undefined || v === '') {
      return new Decimal(0);
    }
    return new Decimal(v.toString());
  } catch {
    return new Decimal(0);
  }
}

function textDecimal(v: Decimal): string {
  return v.toFixed(6).replace(/\.?0+$/, '');
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProductId(value: string | null): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toNumberDate(dateString: string | null | undefined): number {
  return dateString ? Date.parse(dateString) : 0;
}

async function getUser(db: D1Database, email: string) {
  return db
    .prepare('SELECT id, email, display_name AS displayName, role, language FROM users WHERE email = ? AND is_active = 1')
    .bind(email)
    .first<{ id: number; email: string; displayName: string; role: Role; language: 'lt' | 'en' }>();
}

async function isDatabaseInitialized(db: D1Database) {
  try {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first<{ name: string }>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function requireUser(c: any) {
  const db = c.env.WAREHOUSE_DB;
  const initialized = await isDatabaseInitialized(db);
  if (!initialized) {
    return c.json(
      {
        ok: false,
        error:
          'Database not initialized. Run `npm run db:migrate` and `npm run db:seed` first, then retry against this worker.',
      },
      503,
    );
  }
  const email = c.req.header('x-user-email') || c.req.query('email');
  if (!email) return c.json({ ok: false, error: 'x-user-email header or email query param required' }, 401);
  const user = await getUser(db, email.toLowerCase().trim());
  if (!user) {
    return c.json({ ok: false, error: `Unknown user: ${email}` }, 401);
  }
  return c.set('user', {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as Role,
    language: user.language as 'lt' | 'en',
  });
}

async function computeAvailable(db: D1Database, productId: number) {
  const row = await db
    .prepare('SELECT on_hand, reserved, quality_hold FROM stock_balances WHERE product_id = ?')
    .bind(productId)
    .first<{ on_hand: string; reserved: string; quality_hold: string }>();

  if (!row) {
    return { on_hand: '0', reserved: '0', quality_hold: '0', available: '0' };
  }
  const onHand = decimal(row.on_hand);
  const reserved = decimal(row.reserved);
  const hold = decimal(row.quality_hold);
  return {
    on_hand: textDecimal(onHand),
    reserved: textDecimal(reserved),
    quality_hold: textDecimal(hold),
    available: textDecimal(onHand.minus(reserved).minus(hold)),
  };
}

function toMatchCandidates(rawProductId: string | null, products: any[]) {
  const printed = normalizeProductId(rawProductId);
  const exact = products.filter((p) => normalizeProductId(p.product_id) === printed);
  const aliases = products.filter((p) =>
    Array.isArray(p.aliases) && p.aliases.some((alias: string) => normalizeProductId(alias) === printed),
  );
  const normalized = products.filter(
    (p) =>
      !exact.includes(p) &&
      normalizeProductId(p.product_id).includes(printed) &&
      normalizeProductId(p.product_id) !== printed,
  );
  const merged = [...exact, ...aliases, ...normalized];
  return merged.filter((item, idx, list) => list.findIndex((x) => x.id === item.id) === idx).slice(0, 10);
}

function withCandidates(products: any[], lines: any[]) {
  const aliasMap = new Map<number, string[]>();
  for (const p of products) {
    aliasMap.set(p.id, p.aliases ? p.aliases.split('|') : []);
  }
  return lines.map((line) => {
    const candidates = toMatchCandidates(line.printed_product_id || line.edited_product_id || null, products).map(
      (product) => ({
        id: product.id,
        productId: product.product_id,
        description: product.description,
        unit: product.canonical_unit,
        aliases: aliasMap.get(product.id) || [],
      }),
    );
    return {
      ...line,
      candidates,
    };
  });
}

async function getProductsWithAliases(db: D1Database) {
  const products = await db.prepare('SELECT id, product_id, description, canonical_unit FROM products WHERE is_active = 1').all();
  const aliases = await db.prepare('SELECT product_id, alias FROM product_identifier_aliases').all();
  const map = new Map<number, string[]>();
  for (const row of aliases.results as any[]) {
    const list = map.get(row.product_id) || [];
    list.push(row.alias);
    map.set(row.product_id, list);
  }
  return products.results.map((r: any) => ({
    ...r,
    aliases: (map.get(r.id) || []).join('|'),
  }));
}

async function appendAudit(
  db: D1Database,
  actor: { id: number; email: string } | { id?: number; email: string },
  action: string,
  resourceType: string,
  resourceId: string,
  details: unknown,
) {
  const actorUserId = actor.id && actor.id > 0 ? actor.id : null;
  await db
    .prepare(
      'INSERT INTO audit_events (actor_user_id, actor_email, action, resource_type, resource_id, details_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(actorUserId, actor.email, action, resourceType, resourceId, JSON.stringify(details || {}))
    .run();
}

async function applyBalanceDelta(db: D1Database, productId: number, onHandDelta: Decimal) {
  const current = await db.prepare('SELECT on_hand, reserved, quality_hold FROM stock_balances WHERE product_id = ?').bind(productId).first<{
    on_hand: string;
    reserved: string;
    quality_hold: string;
  }>();
  const now = nowIso();
  if (!current) {
    await db
      .prepare('INSERT INTO stock_balances (product_id, on_hand, reserved, quality_hold, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, textDecimal(onHandDelta), '0', '0', now)
      .run();
    return;
  }
  const updatedOnHand = decimal(current.on_hand).add(onHandDelta);
  await db
    .prepare('UPDATE stock_balances SET on_hand = ?, updated_at = ? WHERE product_id = ?')
    .bind(textDecimal(updatedOnHand), now, productId)
    .run();
}

app.get('/', async (c) => {
  const isPreview = (c.env.ENVIRONMENT || 'preview').toUpperCase() === 'PREVIEW';
  const html = `<!doctype html>
    <html lang="lt">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Warehouse Digital</title>
      <style>
        :root { --bg: #f3f7fb; --panel: #ffffff; --text: #12233a; --accent: #0f766e; --warn: #9a3412; --muted: #6b7280; --border: #d8e0ec; --brand:#0f172a; }
        body { margin:0; font-family: 'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif; background: linear-gradient(160deg,#f3f7fb 0%, #e8f0ff 35%, #f3f7fb 100%); color: var(--text); }
        .container { max-width: 1180px; margin: 0 auto; padding: 1rem; }
        .bar { display:flex; gap: 10px; flex-wrap: wrap; justify-content: space-between; align-items: center; background: #0f172a; color: white; padding: 1rem; border-radius: 12px; }
        .badge { background:#e2e8f0; color:#0f172a; padding: 0.2rem 0.7rem; border-radius: 999px; font-size: 0.8rem; }
        .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top:1rem; }
        .panel { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding: 1rem; box-shadow: 0 8px 24px rgba(15,23,42,.06); }
        h2 { margin-top:0; color:#0f172a; }
        table { width:100%; border-collapse: collapse; }
        th,td { text-align:left; padding: 0.55rem; border-bottom: 1px solid var(--border); font-size: 0.93rem; vertical-align: top;}
        thead th { background:#eef3ff; }
        input, select, button { font: inherit; border-radius: 8px; border:1px solid #b9c6df; padding: 0.45rem; }
        .actions { display:flex; gap: 0.6rem; align-items:center; flex-wrap:wrap; }
        .ok { color:#14532d; font-weight:600; }
        .warn { color:var(--warn); font-weight: 600; }
        .small { font-size: 0.84rem; color: var(--muted); }
        .line-edit input { width: 95px; }
        .hidden { display:none; }
        @media (max-width: 980px){ .grid { grid-template-columns: 1fr; } table { font-size: 0.87rem; } .bar{gap:0.5rem;} }
        .row { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin: 1rem 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="bar">
          <div><strong>Warehouse Digital — Preview</strong> <span class="badge">${isPreview ? 'Preview mode' : 'Connected environment'}</span></div>
          <div class="actions">
            <label>Vartotojas / User:
              <input id="userEmail" value="warehouse@demo.local" />
            </label>
            <label>Kalba / Language:
              <select id="lang"><option value="lt" selected>LT</option><option value="en">EN</option></select>
            </label>
            <button id="reloadBtn">Atnaujinti</button>
          </div>
        </div>
        <div class="grid">
          <section class="panel">
            <h2>Inventorius</h2>
            <div class="small" id="inv-meta"></div>
            <div id="inventoryWrap"></div>
          </section>
          <section class="panel">
            <h2>Darbo dėžutė</h2>
            <div id="inboxWrap"></div>
          </section>
        </div>
        <section class="panel" id="reviewPanel">
          <h2>Peržiūros dokumentas</h2>
          <div id="reviewMeta"></div>
          <div id="reviewLines"></div>
          <div class="actions" style="margin-top: 0.8rem;">
            <button id="confirmBtn">Patvirtinti dokumentą</button>
            <button id="cancelBtn">Atšaukti</button>
            <button id="exportBtn">Eksportuoti CSV</button>
            <span id="reviewMessage" class="small"></span>
          </div>
        </section>
      </div>
      <script>
        const state = { user: null, selectedDraftId: null, draft: null, lang: 'lt' };
        const labels = {
          lt: {
            inventory: 'Inventorius',
            inbox: 'Darbo dėžutė',
            review: 'Peržiūros dokumentas',
            confirm: 'Patvirtinti dokumentą',
            cancel: 'Atšaukti',
            available: 'Pasiekiama',
            reserved: 'Rezervuota',
            hold: 'Kokybės sulaikyta',
            onhand: 'Sandėlyje',
            noTasks: 'Nėra laukiančių užduočių',
            unit: 'mat.',
            unknownProduct: 'Nepasirinktas prekių ID',
            confirmButton: 'Patvirtinti',
            resetDone: 'Perkrauta',
          },
          en: {
            inventory: 'Inventory',
            inbox: 'Inbox',
            review: 'Document review',
            confirm: 'Confirm',
            cancel: 'Cancel',
            available: 'Available',
            reserved: 'Reserved',
            hold: 'Quality hold',
            onhand: 'On hand',
            noTasks: 'No pending work',
            unit: 'u',
            unknownProduct: 'Product is not selected',
            confirmButton: 'Confirm',
            resetDone: 'Reloaded',
          },
        };
        const userInput = document.getElementById('userEmail');
        const langInput = document.getElementById('lang');
        const reloadBtn = document.getElementById('reloadBtn');
        const confirmBtn = document.getElementById('confirmBtn');
        const cancelBtn = document.getElementById('cancelBtn');
        const exportBtn = document.getElementById('exportBtn');

        function headers() {
          return { 'x-user-email': userInput.value.trim() };
        }

        async function request(path, method = 'GET', body = null) {
          const init = { method, headers: headers() };
          if (body) init.body = JSON.stringify(body), init.headers['Content-Type'] = 'application/json';
          const r = await fetch(path, init);
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || data.message || 'Request failed');
          return data;
        }

        async function loadMe() {
          const me = await request('/api/me');
          state.user = me.user;
          state.lang = me.user.language || 'lt';
          langInput.value = state.lang;
        }

        async function loadInventory() {
          const data = await request('/api/inventory');
          const html = ['<table><thead><tr><th>ID</th><th>Aprašymas</th><th>vnt.</th><th>Sandėlyje</th><th>Rezervuota</th><th>Kokybinė sulaikymo</th><th>Pasiekiama</th></tr></thead><tbody>']
            .concat(
              data.inventory.map(
                (row) =>
                  '<tr><td>' +
                  row.productId +
                  '</td><td>' +
                  row.description +
                  '</td><td>' +
                  row.unit +
                  '</td><td>' +
                  row.onHand +
                  '</td><td>' +
                  row.reserved +
                  '</td><td>' +
                  row.qualityHold +
                  '</td><td>' +
                  row.available +
                  '</td></tr>',
              ),
            )
            .concat(['</tbody></table>']).join('');
          const refreshedAt = new Date().toLocaleString();
          document.getElementById('inv-meta').textContent =
            (state.lang === 'lt' ? 'Atnaujinta' : 'Last refresh') + ': ' + refreshedAt;
          document.getElementById('inventoryWrap').innerHTML = html;
        }

        async function selectDraft(id) {
          state.selectedDraftId = id;
          const details = await request('/api/review-cases/' + id);
          state.draft = details.draft;
          renderReview();
        }

        function renderReview() {
          const draft = state.draft;
          if (!draft) return;
          const rows = [
            '<table><thead><tr><th>Eil.</th><th>Atspausdinta prekė</th><th>Kiekyje</th><th>Matą</th><th>Pozicijos ID</th><th>Paieška</th><th>Būsena</th></tr></thead><tbody>',
          ]
            .concat(draft.lines.map((line) => {
              const cands = line.candidates || [];
              const options = cands
                .map(
                  (c) =>
                    '<option value="' +
                    c.id +
                    '" ' +
                    (c.id === line.matchedProductId ? 'selected' : '') +
                    '>' +
                    c.productId +
                    ' — ' +
                    c.description +
                    '</option>',
                )
                .join('');
              const unknown = '<option value="">' + labels[state.lang].unknownProduct + '</option>';
              return (
                '<tr data-line="' +
                line.id +
                '"><td>' +
                line.lineNo +
                '</td><td>' +
                (line.printedDescription || '') +
                '</td><td><input class="line-edit" data-field="editedQuantity" value="' +
                line.editedQuantity +
                '" /></td><td><input class="line-edit" data-field="editedUnit" value="' +
                line.editedUnit +
                '" /></td><td><input class="line-edit" data-field="editedProductId" value="' +
                (line.editedProductId || '') +
                '" /></td><td><select data-field="match">' +
                options +
                unknown +
                '</select></td><td>' +
                line.matchStatus +
                (line.warning ? ' ⚠ ' + line.warning : '') +
                '</td></tr>'
              );
            }))
            .concat(['</tbody></table>']).join('');
          document.getElementById('reviewMeta').innerHTML =
            '<div><strong>' + draft.documentNumber + '</strong> — ' + draft.counterpartName + ' (' + draft.status + ')</div><div class="small">' + draft.documentType + '</div>';
          document.getElementById('reviewLines').innerHTML = rows;
          document.querySelectorAll('select[data-field="match"], input.line-edit').forEach((el) => {
            el.addEventListener('change', async (event) => {
              const target = event.target;
              const row = target.closest('tr');
              const lineId = Number(row.dataset.line);
              const body = {};
              const lineField = target.getAttribute('data-field');
              if (lineField === 'match') body.matchedProductId = Number(target.value) || null;
              if (lineField === 'editedProductId') body.editedProductId = target.value || null;
              if (lineField === 'editedQuantity') body.editedQuantity = target.value || null;
              if (lineField === 'editedUnit') body.editedUnit = target.value || null;
              try {
                await request('/api/review-cases/' + draft.id + '/lines/' + lineId, 'PUT', body);
                document.getElementById('reviewMessage').textContent = labels[state.lang].resetDone + '.';
              } catch (e) {
                alert(e.message);
              }
            });
          });
        }

        async function loadInbox() {
          const inbox = await request('/api/inbox');
          if (!inbox.cases || !inbox.cases.length) {
            document.getElementById('inboxWrap').textContent = labels[state.lang].noTasks;
            return;
          }
          const rows = ['<table><thead><tr><th>Dokumentas</th><th>Tipas</th><th>Statusas</th><th>Įspėjimas</th><th>Veiksmas</th></tr></thead><tbody>']
            .concat(
              inbox.cases.map(
                (item) =>
                  '<tr><td>' +
                    item.documentNumber +
                    '</td><td>' +
                    item.documentType +
                    '</td><td>' +
                    item.status +
                    '</td><td>' +
                    (item.warning || '-') +
                    '</td><td><button data-open="' +
                    item.id +
                    '">Atidaryti</button></td></tr>',
              ),
            )
            .concat(['</tbody></table>']).join('');
          document.getElementById('inboxWrap').innerHTML = rows;
          document.querySelectorAll('[data-open]').forEach((el) => {
            el.addEventListener('click', async () => {
              const id = el.getAttribute('data-open');
              await selectDraft(id);
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            });
          });
        }

        confirmBtn.addEventListener('click', async () => {
          if (!state.selectedDraftId) return;
          await request('/api/review-cases/' + state.selectedDraftId + '/confirm', 'POST');
          document.getElementById('reviewMessage').textContent = state.lang === 'lt' ? 'Dokumentas patvirtintas.' : 'Document confirmed.';
          await refreshAll();
        });

        cancelBtn.addEventListener('click', async () => {
          if (!state.selectedDraftId) return;
          await request('/api/review-cases/' + state.selectedDraftId + '/cancel', 'POST');
          document.getElementById('reviewMessage').textContent = state.lang === 'lt' ? 'Dokumentas atšauktas.' : 'Document cancelled.';
          await refreshAll();
        });

        exportBtn.addEventListener('click', async () => {
          const csv = await request('/api/reports/stock', 'GET');
          const blob = new Blob([csv.csv], { type: 'text/csv;charset=utf-8;' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'stock-export.csv';
          link.click();
          URL.revokeObjectURL(link.href);
        });

        reloadBtn.addEventListener('click', refreshAll);
        langInput.addEventListener('change', () => {
          state.lang = langInput.value;
          loadMe().then(loadInventory).then(loadInbox);
        });

        async function refreshAll() {
          document.getElementById('reviewMessage').textContent = '';
          try {
            await loadMe();
            await loadInventory();
            await loadInbox();
            document.getElementById('reviewMeta').textContent = '';
            document.getElementById('reviewLines').innerHTML = '';
            state.selectedDraftId = null;
            state.draft = null;
          } catch (e) {
            document.getElementById('reviewMessage').textContent = e.message;
          }
        }

        document.addEventListener('DOMContentLoaded', refreshAll);
      </script>
    </body>
    </html>`;
  return c.html(html);
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/me', async (c) => {
  const email = c.req.header('x-user-email') || c.req.query('email');
  if (!email) {
    return c.json({ ok: false, error: 'Missing email header or query param.' }, 401);
  }
  const initialized = await isDatabaseInitialized(c.env.WAREHOUSE_DB);
  if (!initialized) {
    return c.json(
      {
        ok: false,
        error:
          'Database not initialized. Run `npm run db:migrate` and `npm run db:seed` first, then retry against this worker.',
      },
      503,
    );
  }
  const user = await getUser(c.env.WAREHOUSE_DB, email.toLowerCase().trim());
  if (!user) return c.json({ ok: false, error: 'Unknown user' }, 401);
  return c.json({ ok: true, user: { id: user.id, email: user.email, role: user.role, language: user.language } });
});

app.post('/api/admin/users', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  if (actor.role !== 'ADMIN') return c.json({ ok: false, error: 'Only admin may add users' }, 403);
  const payload = await c.req.json();
  const email = String(payload?.email || '').toLowerCase().trim();
  const role = String(payload?.role || '').toUpperCase();
  const displayName = String(payload?.displayName || email);
  if (!email || !['WAREHOUSE', 'SALES', 'ADMIN'].includes(role)) {
    return c.json({ ok: false, error: 'Invalid payload' }, 400);
  }
  await c.env.WAREHOUSE_DB
    .prepare('INSERT OR IGNORE INTO users(email, display_name, role, language) VALUES (?, ?, ?, ?)')
    .bind(email, displayName, role, payload?.language || 'lt')
    .run();
  await appendAudit(c.env.WAREHOUSE_DB, actor, 'USER_CREATED', 'users', email, { role });
  return c.json({ ok: true });
});

app.post('/api/admin/preview/reset', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  if (actor.role !== 'ADMIN') return c.json({ ok: false, error: 'Only admin can reset the preview' }, 403);

  await c.env.WAREHOUSE_DB.prepare('DELETE FROM stock_movements').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM approval_snapshots').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM review_lines').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM review_drafts').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM source_documents').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM outbox_events').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM reservations').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM quality_holds').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM product_identifier_aliases').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM stock_balances').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM products').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM users').run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM audit_events').run();

  const seedUsers = [
    'INSERT INTO users (email, display_name, role, language) VALUES (\'warehouse@demo.local\', \'Sandelys\', \'WAREHOUSE\', \'lt\'), (\'sales@demo.local\', \'Pardavimai\', \'SALES\', \'lt\'), (\'admin@demo.local\', \'Admin\', \'ADMIN\', \'lt\')',
    'INSERT INTO products (product_id, description, canonical_unit) VALUES (\'KAIN001\', \'Medvilninė audinio juosta 200 cm\', \'m\'), (\'KAIN002\', \'Mikro pluošto užpilas\', \'m\'), (\'KAIN003\', \'Pamušalas „SoftLux“\', \'m\')',
  ];
  const seedDrafts = [
    'INSERT INTO stock_balances (product_id, on_hand, reserved, quality_hold) SELECT id, \'0\', \'0\', \'0\' FROM products',
    'INSERT INTO source_documents (channel, external_id, filename, source_hash, file_version, payload_json) VALUES (\'SIMULATED_GMAIL\', \'SUP-2026-09-01\', \'pavyzdys-supplier.pdf\', \'sha256-demo-001\', 1, \'{"source\":\"round2a-manual"}\'), (\'SIMULATED_DRIVE\', \'CLI-2026-09-01\', \'pavyzdys-invoice.pdf\', \'sha256-demo-002\', 1, \'{"source\":\"round2a-manual"}\')',
    'INSERT INTO review_drafts (id, draft_type, status, source_document_id, source_ref, counterpart_name, document_number, issue_date, currency, total_amount) VALUES (\'draft-supplier-example\', \'SUPPLIER_RECEIPT\', \'PENDING\', 1, \'GMAIL://SUP-2026-09-01\', \'Pavyzdys tiekėjas UAB\', \'G-2026-09-01\', \'2026-09-01\', \'EUR\', \'540\'), (\'draft-client-example\', \'CLIENT_INVOICE\', \'PENDING\', 2, \'DRIVE://CLI-2026-09-01\', \'Pavyzdys klientas AB\', \'I-2026-09-01\', \'2026-09-01\', \'EUR\', \'380\')',
    'INSERT INTO review_lines (draft_id, line_no, printed_product_id, printed_description, printed_quantity, printed_unit, printed_unit_price, printed_currency, source_evidence, extraction_confidence, interpretation, interpreted_product_id, interpreted_quantity, interpreted_unit, interpreted_unit_price, interpreted_currency, edited_product_id, edited_description, edited_quantity, edited_unit, edited_unit_price, edited_currency, matched_product_id, match_status, requires_human_action, is_stock_line) VALUES (\'draft-supplier-example\', 1, \'KAIN001\', \'Medvilninė audinio juosta\', \'100\', \'m\', \'4.50\', \'EUR\', \'Table Row 1\', 0.98, \'OK\', \'KAIN001\', \'100\', \'m\', \'4.50\', \'EUR\', \'KAIN001\', \'Medvilninė audinio juosta 200 cm\', \'100\', \'m\', \'4.50\', \'EUR\', 1, \'MATCHED\', 0, 1), (\'draft-supplier-example\', 2, \'KAIN003\', \'Pamušalo medžiaga\', \'20\', \'m\', \'6.00\', \'EUR\', \'Table Row 2\', 0.89, \'NeedsReview\', \'KAIN003\', \'20\', \'m\', \'6.00\', \'EUR\', NULL, NULL, \'20\', \'m\', \'6.00\', \'EUR\', NULL, \'UNRESOLVED\', 1, 1), (\'draft-client-example\', 1, \'KAIN001\', \'Medvilninė audinio juosta\', \'40\', \'m\', \'12.00\', \'EUR\', \'Table Row 1\', 0.96, \'OK\', \'KAIN001\', \'40\', \'m\', \'12.00\', \'EUR\', \'KAIN001\', \'Medvilninė audinio juosta 200 cm\', \'40\', \'m\', \'12.00\', \'EUR\', 1, \'MATCHED\', 0, 1), (\'draft-client-example\', 2, \'KAIN999\', \'Nežinomas audinys\', \'15\', \'m\', \'8.00\', \'EUR\', \'Table Row 2\', 0.42, \'UnknownProduct\', \'KAIN999\', \'15\', \'m\', \'8.00\', \'EUR\', NULL, NULL, \'15\', \'m\', \'8.00\', \'EUR\', NULL, \'UNRESOLVED\', 1, 1)',
  ];
  const seedAliases = ['INSERT INTO product_identifier_aliases (product_id, alias) SELECT id, product_id || "-OLD" FROM products'];
  const resetSql = [...seedUsers, ...seedAliases, ...seedDrafts];
  for (const query of resetSql) {
    await c.env.WAREHOUSE_DB.prepare(query).run();
  }
  await appendAudit(c.env.WAREHOUSE_DB, actor, 'PREVIEW_RESET', 'system', 'all', {});
  return c.json({ ok: true });
});

app.get('/api/inventory', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const db = c.env.WAREHOUSE_DB;
  const rows = await db
    .prepare(
      'SELECT p.id, p.product_id AS productId, p.description, p.canonical_unit AS unit, b.on_hand, b.reserved, b.quality_hold FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id ORDER BY p.product_id',
    )
    .all();
  const inventory = [];
  for (const row of rows.results as any[]) {
    const qty = await computeAvailable(db, Number(row.id));
    inventory.push({
      productId: row.productId,
      description: row.description,
      unit: row.unit,
      onHand: textDecimal(decimal(row.on_hand)),
      reserved: textDecimal(decimal(row.reserved)),
      qualityHold: textDecimal(decimal(row.quality_hold)),
      available: qty.available,
    });
  }
  return c.json({ inventory });
});

app.get('/api/inbox', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  const statusFilter = c.req.query('status') || 'PENDING';

  let typeFilter = '';
  if (actor.role === 'WAREHOUSE') typeFilter = "AND d.draft_type = 'SUPPLIER_RECEIPT'";
  if (actor.role === 'SALES') typeFilter = "AND d.draft_type IN ('CLIENT_INVOICE', 'CLIENT_CREDIT')";

  const rows = await c.env.WAREHOUSE_DB
    .prepare(`SELECT d.id, d.draft_type AS draftType, d.status, d.document_number AS documentNumber, d.counterpart_name AS counterpartName, d.updated_at AS updatedAt, d.created_at AS createdAt
      FROM review_drafts d
      WHERE d.status = ?
      ${typeFilter}
      ORDER BY d.created_at ASC`)
    .bind(statusFilter)
    .all();

  const now = Date.now();
  const cases = (rows.results as any[]).map((r) => {
    const created = toNumberDate(r.createdAt);
    const ageDays = Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
    const overDue =
      (r.draftType === 'SUPPLIER_RECEIPT' && ageDays > 5) || (r.draftType.startsWith('CLIENT_') && ageDays > 90);
    return {
      id: r.id,
      documentType: r.draftType,
      status: r.status,
      documentNumber: r.documentNumber,
      counterpartName: r.counterpartName,
      createdAt: r.createdAt,
      warning: overDue ? (actor.role === 'WAREHOUSE' ? 'Overdue confirmation' : 'Pending >30 days') : null,
    };
  });
  return c.json({ cases });
});

app.get('/api/review-cases/:id', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const draftId = c.req.param('id');
  const draft = await c.env.WAREHOUSE_DB
    .prepare('SELECT * FROM review_drafts WHERE id = ?')
    .bind(draftId)
    .first<any>();
  if (!draft) return c.json({ ok: false, error: 'Draft not found' }, 404);

  const linesRes = await c.env.WAREHOUSE_DB.prepare('SELECT * FROM review_lines WHERE draft_id = ? ORDER BY line_no').bind(draftId).all();
  const products = await getProductsWithAliases(c.env.WAREHOUSE_DB);
  const withCandidatesLines = withCandidates(products as any, linesRes.results as any[]);
  const draftData = {
    id: draft.id,
    draftType: draft.draft_type,
    documentType: draft.draft_type,
    status: draft.status,
    sourceRef: draft.source_ref,
    counterpartName: draft.counterpart_name,
    documentNumber: draft.document_number,
    issueDate: draft.issue_date,
    currency: draft.currency,
    totalAmount: draft.total_amount,
    lines: withCandidatesLines.map((line: any) => ({
      id: line.id,
      lineNo: line.line_no,
      printedDescription: line.printed_description,
      printedProductId: line.printed_product_id,
      printedQuantity: line.printed_quantity,
      printedUnit: line.printed_unit,
      editedProductId: line.edited_product_id,
      editedDescription: line.edited_description,
      editedQuantity: line.edited_quantity || line.printed_quantity,
      editedUnit: line.edited_unit || line.printed_unit,
      matchedProductId: line.matched_product_id,
      matchStatus: line.match_status,
      warning: line.warning_json ? JSON.parse(line.warning_json).message : null,
      candidates: line.candidates,
    })),
  };
  return c.json({ draft: draftData });
});

app.put('/api/review-cases/:id/lines/:lineId', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  const { id, lineId } = c.req.param();
  const payload = await c.req.json().catch(() => ({}));
  const draft = await c.env.WAREHOUSE_DB.prepare('SELECT status, draft_type FROM review_drafts WHERE id = ?').bind(id).first<any>();
  if (!draft) return c.json({ ok: false, error: 'Draft not found' }, 404);
  if (!['PENDING', 'REVIEW'].includes(draft.status)) return c.json({ ok: false, error: 'Draft is not editable' }, 409);

  const line = await c.env.WAREHOUSE_DB
    .prepare('SELECT * FROM review_lines WHERE id = ? AND draft_id = ?')
    .bind(Number(lineId), id)
    .first<any>();
  if (!line) return c.json({ ok: false, error: 'Line not found' }, 404);
  if (draft.draft_type === 'SUPPLIER_RECEIPT' && actor.role === 'SALES') {
    return c.json({ ok: false, error: 'Sales role cannot edit supplier receipts' }, 403);
  }
  if (draft.draft_type === 'CLIENT_INVOICE' && actor.role === 'WAREHOUSE') {
    return c.json({ ok: false, error: 'Warehouse role cannot edit client invoices' }, 403);
  }

  const fields = [
    ['edited_product_id', payload.editedProductId ?? line.edited_product_id],
    ['edited_description', payload.editedDescription ?? line.edited_description],
    ['edited_quantity', payload.editedQuantity ?? line.edited_quantity],
    ['edited_unit', payload.editedUnit ?? line.edited_unit],
    ['edited_currency', payload.editedCurrency ?? line.edited_currency],
    ['edited_unit_price', payload.editedUnitPrice ?? line.edited_unit_price],
  ];
  const matchedProductId = payload.matchedProductId ?? line.matched_product_id;
  const matchStatus = matchedProductId ? 'MATCHED' : 'UNRESOLVED';
  const updates: Record<string, any> = {
    edited_product_id: fields[0][1],
    edited_description: fields[1][1],
    edited_quantity: fields[2][1],
    edited_unit: fields[3][1],
    edited_currency: fields[4][1],
    edited_unit_price: fields[5][1],
    matched_product_id: matchedProductId,
    match_status: matchStatus,
    requires_human_action: matchStatus === 'MATCHED' ? 0 : 1,
    updated_at: nowIso(),
  };

  const setClause = Object.keys(updates)
    .map((key, idx) => `${key} = ?${idx === Object.keys(updates).length - 1 ? '' : ','}`)
    .join(' ');
  const bind = Object.values(updates);
  await c.env.WAREHOUSE_DB.prepare(`UPDATE review_lines SET ${setClause} WHERE id = ?`).bind(...bind, Number(lineId)).run();
  await appendAudit(c.env.WAREHOUSE_DB, actor, 'REVIEW_LINE_EDIT', 'review_lines', String(lineId), {
    draftId: id,
  });
  return c.json({ ok: true });
});

app.post('/api/review-cases/:id/confirm', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  const draftId = c.req.param('id');

  const draft = await c.env.WAREHOUSE_DB.prepare('SELECT * FROM review_drafts WHERE id = ?').bind(draftId).first<any>();
  if (!draft) return c.json({ ok: false, error: 'Draft not found' }, 404);
  if (!['PENDING', 'REVIEW'].includes(draft.status)) return c.json({ ok: false, error: 'Draft is already processed' }, 409);

  if (draft.draft_type === 'SUPPLIER_RECEIPT' && actor.role === 'SALES') {
    return c.json({ ok: false, error: 'Only Warehouse or Admin can confirm supplier receipts' }, 403);
  }
  if (draft.draft_type === 'CLIENT_INVOICE' && actor.role === 'WAREHOUSE') {
    return c.json({ ok: false, error: 'Only Sales or Admin can confirm client invoices' }, 403);
  }

  const lines = await c.env.WAREHOUSE_DB.prepare('SELECT * FROM review_lines WHERE draft_id = ?').bind(draftId).all();
  const unresolved = (lines.results as any[]).filter((l) => l.is_stock_line === 1 && l.requires_human_action === 1);
  if (unresolved.length > 0) return c.json({ ok: false, error: 'Resolve all product matches before confirmation' }, 409);

  const now = nowIso();
  const snapshot = {
    draftId,
    reviewer: actor.email,
    at: now,
    lines: lines.results,
  };

  const movementMultiplier = draft.draft_type === 'SUPPLIER_RECEIPT' ? 1 : -1;
  const statements: any[] = [];

  for (const line of lines.results as any[]) {
    const qty = decimal(line.edited_quantity || line.printed_quantity);
    const unit = line.edited_unit || line.printed_unit;
    const price = decimal(line.edited_unit_price || line.printed_unit_price);
    const matched = Number(line.matched_product_id || 0);
    if (line.is_stock_line === 1 && matched <= 0) {
      return c.json({ ok: false, error: `Line ${line.line_no} missing product match` }, 409);
    }
    if (line.is_stock_line === 1 && qty.lessThan(0)) {
      return c.json({ ok: false, error: `Line ${line.line_no} has invalid quantity` }, 400);
    }
    if (line.is_stock_line === 1 && draft.draft_type === 'CLIENT_INVOICE') {
      const availability = await computeAvailable(c.env.WAREHOUSE_DB, matched);
      const onHand = decimal(availability.available);
      if (onHand.lessThan(qty)) {
        return c.json(
          { ok: false, error: `Insufficient stock for line ${line.line_no}. Available: ${availability.available}, required: ${textDecimal(qty)}` },
          409,
        );
      }
    }
    if (line.is_stock_line === 1 && qty.greaterThan(0)) {
      const movement = (line.edited_unit_price || line.printed_unit_price) ? price : decimal(0);
      statements.push(
        c.env.WAREHOUSE_DB
          .prepare(
            'INSERT INTO stock_movements (product_id, movement_type, quantity, unit, unit_price, currency, source_draft_id, actor_user_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            matched,
            draft.draft_type === 'SUPPLIER_RECEIPT' ? 'RECEIPT' : 'SALE',
            textDecimal(qty.mul(movementMultiplier)),
            unit,
            movement.toFixed(6),
            line.edited_currency || line.printed_currency || 'EUR',
            draftId,
            actor.id,
            `confirmed:${draft.draft_type}`,
          ),
      );
      await applyBalanceDelta(c.env.WAREHOUSE_DB, matched, qty.mul(movementMultiplier));
    }
  }

  statements.push(
    c.env.WAREHOUSE_DB
      .prepare(
        'INSERT INTO approval_snapshots (draft_id, approver_id, approval_type, snapshot_json) VALUES (?, ?, ?, ?)',
      )
      .bind(draftId, actor.id, draft.draft_type === 'SUPPLIER_RECEIPT' ? 'RECEIPT_CONFIRM' : 'SALE_CONFIRM', JSON.stringify(snapshot)),
  );
  statements.push(c.env.WAREHOUSE_DB.prepare('UPDATE review_drafts SET status = ?, reviewer_id = ?, approved_at = ?, updated_at = ? WHERE id = ?').bind('COMPLETED', actor.id, now, now, draftId));
  statements.push(
    c.env.WAREHOUSE_DB
      .prepare(
        "INSERT INTO outbox_events (draft_id, event_type, payload_json, status) VALUES (?, 'STOCK_COMMIT', ?, 'PENDING')",
      )
      .bind(draftId, JSON.stringify({ sourceDraftId: draftId, approvedAt: now })),
  );

  await c.env.WAREHOUSE_DB.batch(statements);
  await appendAudit(c.env.WAREHOUSE_DB, actor, 'DRAFT_CONFIRMED', 'review_drafts', draftId, {
    type: draft.draft_type,
    lineCount: lines.results.length,
  });
  return c.json({ ok: true });
});

app.post('/api/review-cases/:id/cancel', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  const draftId = c.req.param('id');
  const draft = await c.env.WAREHOUSE_DB.prepare('SELECT * FROM review_drafts WHERE id = ?').bind(draftId).first<any>();
  if (!draft) return c.json({ ok: false, error: 'Draft not found' }, 404);
  if (!['PENDING', 'REVIEW'].includes(draft.status)) return c.json({ ok: false, error: 'Draft already processed' }, 409);
  const now = nowIso();
  await c.env.WAREHOUSE_DB.prepare('UPDATE review_drafts SET status = ?, updated_at = ? WHERE id = ?').bind('CANCELLED', now, draftId).run();
  await c.env.WAREHOUSE_DB.prepare('DELETE FROM reservations WHERE draft_id = ?').bind(draftId).run();
  await appendAudit(c.env.WAREHOUSE_DB, actor, 'DRAFT_CANCELLED', 'review_drafts', draftId, { type: draft.draft_type });
  return c.json({ ok: true });
});

app.get('/api/reports/stock', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const invRows = await c.env.WAREHOUSE_DB
    .prepare('SELECT p.product_id, p.description, b.on_hand, b.reserved, b.quality_hold FROM products p JOIN stock_balances b ON b.product_id = p.id')
    .all();
  const headers = ['product_id', 'description', 'on_hand', 'reserved', 'quality_hold', 'available'];
  const csv = [headers.join(',')]
    .concat(
      (invRows.results as any[]).map((r) => {
        const available = decimal(r.on_hand).minus(r.reserved).minus(r.quality_hold);
        return `${r.product_id},"${r.description}",${textDecimal(decimal(r.on_hand))},${textDecimal(decimal(r.reserved))},${textDecimal(decimal(
          r.quality_hold,
        ))},${textDecimal(available)}`;
      }),
    )
    .join('\n');
  return c.json({ csv });
});

app.get('/api/orchestrator/status', async (c) => {
  const seedResp = await requireUser(c);
  if (seedResp) return seedResp;
  const actor = c.get('user');
  if (actor.role !== 'ADMIN') return c.json({ ok: false, error: 'Only admin can see orchestrator status' }, 403);
  const movementCount = await c.env.WAREHOUSE_DB.prepare('SELECT COUNT(1) AS c FROM stock_movements').first<{ c: number }>();
  const pendingOutbox = await c.env.WAREHOUSE_DB.prepare("SELECT COUNT(1) AS c FROM outbox_events WHERE status = 'PENDING'").first<{ c: number }>();
  const failures = await c.env.WAREHOUSE_DB.prepare("SELECT COUNT(1) AS c FROM outbox_events WHERE status = 'FAILED'").first<{ c: number }>();
  return c.json({
    ok: true,
    environment: c.env.ENVIRONMENT || 'preview',
    metrics: {
      totalMovements: Number(movementCount?.c || 0),
      pendingOutboxEvents: Number(pendingOutbox?.c || 0),
      failedOutboxEvents: Number(failures?.c || 0),
    },
  });
});

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    const db = env.WAREHOUSE_DB;
    await appendAudit(db, { id: 0, email: 'system@local' }, 'SCHEDULED_RUN', 'orchestrator', event.cron, {
      triggeredAt: nowIso(),
    });
    const status = await db.prepare('SELECT COUNT(1) AS c FROM review_drafts WHERE status = ?').bind('PENDING').first<{ c: number }>();
    const pendingCount = Number(status?.c || 0);
    if (pendingCount > 0) {
      ctx.waitUntil(
        Promise.resolve(
          appendAudit(
            db,
            { id: 0, email: 'system@local' },
            'SCHEDULED_PENDING_SUMMARY',
            'review_drafts',
            'pending',
            { pendingCount },
          ),
        ),
      );
    }
  },
};
