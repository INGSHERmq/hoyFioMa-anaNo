/* ==========================================================================
   LÓGICA CONEXIÓN CON SUPABASE EN TIEMPO REAL - "HOY FÍO MAÑANA NO"
   ========================================================================== */

const EMPTY_STATE = { customers: [], items: [], payments: [], chat: [] };

// --- DIAGNÓSTICO: imprime con prefijo en consola ---
const DBG = true;
function dbg(...args) {
  if (DBG) console.log('[HF]', ...args);
}

// --- SEGURIDAD: SANITIZACIÓN XSS ---
// Escapa caracteres HTML peligrosos antes de insertar datos en innerHTML.
// SIEMPRE usar esta función con datos que vienen de la BD o del usuario.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- MODALES Y UTILIDADES ---
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

let appState = { ...EMPTY_STATE };
let currentUser = null;
let pendingGoogleUser = null;
let isSavingRole = false;
let authTabMode = 'login';
let registerRole = 'vendedor';
let selectedCustomerId = null;
let deferredPrompt = null;
let supabaseClient = null;
let sessionLoadPromise = null;
let sessionLoadUserId = null;
let fetchSeq = 0;
let lastLoadError = null;

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  initSupabaseClient();
  registerServiceWorker();
  initPWAInstall();
});

function waitForSupabase(maxMs = 8000) {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(true);
    const started = Date.now();
    const tick = () => {
      if (window.supabase) return resolve(true);
      if (Date.now() - started >= maxMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function initSupabaseClient() {
  const statusBadge = document.getElementById('supabaseStatusDot');
  if (statusBadge) statusBadge.innerText = '🟡 Conectando…';

  const supabaseReady = await waitForSupabase();
  const cfgUrl = typeof SUPABASE_CONFIG !== 'undefined' ? SUPABASE_CONFIG.url : '';
  const cfgKey = typeof SUPABASE_CONFIG !== 'undefined' ? SUPABASE_CONFIG.anonKey : '';

  if (!supabaseReady || !cfgUrl || !cfgKey) {
    if (statusBadge) statusBadge.innerText = '🔴 Base de datos no disponible';
    console.error('Supabase no disponible:', { supabaseReady, cfgUrl: !!cfgUrl, cfgKey: !!cfgKey });
    showAuthScreen();
    return;
  }

  try {
    supabaseClient = window.supabase.createClient(cfgUrl, cfgKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    dbg('Supabase client creado:', cfgUrl);
    if (statusBadge) statusBadge.innerText = '🟢 Base de datos conectada';

    supabaseClient.auth.onAuthStateChange((event, session) => {
      dbg('auth event:', event, 'user:', session?.user?.id || null);
      if (event === 'INITIAL_SESSION') {
        if (session?.user) {
          handleSupabaseSession(session.user);
        } else {
          showAuthScreen();
        }
        return;
      }
      if (event === 'SIGNED_IN' && session?.user) {
        handleSupabaseSession(session.user);
      } else if (event === 'SIGNED_OUT') {
        sessionLoadUserId = null;
        sessionLoadPromise = null;
        showAuthScreen();
      }
    });
  } catch (err) {
    console.error('Error al inicializar Supabase:', err);
    if (statusBadge) statusBadge.innerText = '⚠️ Error Supabase';
    showAuthScreen();
  }
}

function mapDbCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.full_name,
    phone: row.phone,
    code: row.access_code,
    notes: row.notes || ''
  };
}

async function fetchLinkedCustomerRecord() {
  dbg('RPC get_my_linked_customer → iniciando');
  const { data, error } = await supabaseClient.rpc('get_my_linked_customer');
  if (error) {
    dbg('RPC get_my_linked_customer → ERROR:', error);
    throw error;
  }
  dbg('RPC get_my_linked_customer → data:', data);
  return mapDbCustomer(data);
}

async function loadCustomersForUser(nextState) {
  if (currentUser.role === 'cliente') {
    const linked = await fetchLinkedCustomerRecord();
    dbg('clientes (cliente/vinculado):', linked);
    nextState.customers = linked ? [linked] : [];
    return;
  }

  const { data: customersData, error: custErr } = await supabaseClient.from('customers').select('*');
  if (custErr) {
    dbg('consulta customers → ERROR:', custErr);
    throw custErr;
  }
  dbg('consulta customers → filas:', (customersData || []).length, customersData);
  nextState.customers = (customersData || []).map(mapDbCustomer);
}

// CARGA REAL DE DATOS DESDE SUPABASE (CLIENTES, ÍTEMS, PAGOS, CHAT)
// Devuelve { ok: true } en éxito o { ok: false, error } con el paso exacto que falló.
// En caso de error se renderiza lo que sí se pudo cargar para nunca dejar la pantalla en blanco.
async function fetchDataFromSupabase() {
  if (!supabaseClient || !currentUser) return { ok: false, error: 'Sesión no disponible' };

  const seq = ++fetchSeq;
  const nextState = { ...EMPTY_STATE };
  const failures = [];

  const loadCustomersForUserWrapped = async () => {
    try {
      await loadCustomersForUser(nextState);
    } catch (e) {
      failures.push(`customers: ${e?.message || e}`);
      throw e;
    }
  };
  const queryWrapped = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      failures.push(`${label}: ${e?.message || e}`);
      throw e;
    }
  };

  try {
    await loadCustomersForUserWrapped();
    if (seq !== fetchSeq) return { ok: true, error: null };
    dbg('fetch #' + seq + ' | clientes OK:', nextState.customers.length);

    const accountsData = await queryWrapped('fiado_accounts', async () => {
      const { data, error } = await supabaseClient.from('fiado_accounts').select('id, customer_id');
      if (error) throw error;
      return data || [];
    });
    if (seq !== fetchSeq) return { ok: true, error: null };
    dbg('fetch #' + seq + ' | fiado_accounts OK:', accountsData.length);
    const accountToCustomer = new Map(accountsData.map(a => [a.id, a.customer_id]));

    nextState.items = await queryWrapped('fiado_items', async () => {
      const { data, error } = await supabaseClient.from('fiado_items').select('*');
      if (error) throw error;
      return (data || []).map(i => ({
        id: i.id,
        customerId: accountToCustomer.get(i.account_id),
        name: i.product_name,
        qty: parseFloat(i.quantity),
        unitPrice: parseFloat(i.unit_price),
        date: i.item_date,
        verified: i.verified_by_customer
      }));
    });
    if (seq !== fetchSeq) return { ok: true, error: null };
    dbg('fetch #' + seq + ' | fiado_items OK:', nextState.items.length);

    nextState.payments = await queryWrapped('payments', async () => {
      const { data, error } = await supabaseClient.from('payments').select('*');
      if (error) throw error;
      return (data || []).map(p => ({
        id: p.id,
        customerId: accountToCustomer.get(p.account_id),
        amount: parseFloat(p.amount),
        date: p.created_at ? p.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
        method: p.payment_method
      }));
    });
    if (seq !== fetchSeq) return { ok: true, error: null };
    dbg('fetch #' + seq + ' | payments OK:', nextState.payments.length);

    nextState.chat = await queryWrapped('chat_messages', async () => {
      const { data, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(m => ({
        id: m.id,
        customerId: m.customer_id,
        sender: m.sender_type,
        text: m.message,
        time: m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      }));
    });
    if (seq !== fetchSeq) return { ok: true, error: null };
    dbg('fetch #' + seq + ' | chat OK:', nextState.chat.length);

    appState = nextState;

    if (currentUser.role === 'cliente') {
      const linked = appState.customers[0];
      if (linked) {
        selectedCustomerId = linked.id;
        currentUser.customerId = linked.id;
      }
    }

    lastLoadError = null;
    renderCurrentRoleView();
    dbg('fetch #' + seq + ' → COMPLETADO. customers en appState:', appState.customers.length);
    return { ok: true, error: null };
  } catch (e) {
    if (seq !== fetchSeq) return { ok: true, error: null };
    console.error('Error cargando datos de Supabase en', failures, e);
    appState = nextState;
    lastLoadError = failures.length ? failures.join(' | ') : (e?.message || 'Error desconocido al cargar los datos');
    renderCurrentRoleView();
    dbg('fetch #' + seq + ' → FALLÓ:', lastLoadError);
    return { ok: false, error: lastLoadError };
  }
}

function renderLoadErrorBanner() {
  if (!lastLoadError) return '';
  return `
    <div style="background: #FDE8E8; border: 1px solid #F5A6A6; color: #B00020; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; font-size: 0.85rem;">
      <strong>⚠️ No se pudo cargar toda la información.</strong>
      <br>Detalle: <code style="font-size: 0.75rem;">${escapeHtml(lastLoadError)}</code>
      <br><button class="btn btn-outline btn-sm" style="margin-top: 8px;" onclick="forceRefreshAll()">🔄 Reintentar carga</button>
    </div>`;
}

async function forceRefreshAll() {
  lastLoadError = null;
  showRoleLoadingView();
  const result = await fetchDataFromSupabase();
  if (!result.ok) {
    alert('No se pudieron cargar los datos.\n\nDetalle: ' + result.error);
  }
}

function renderCurrentRoleView() {
  if (!currentUser) return;
  const container = currentUser.role === 'vendedor'
    ? document.getElementById('vendedorScreen')
    : document.getElementById('clienteScreen');
  dbg('renderCurrentRoleView →', currentUser.role, '| customers:', appState.customers.length, '| selectedCustomerId:', selectedCustomerId);
  try {
    if (currentUser.role === 'vendedor') {
      renderVendedorView(container);
    } else {
      renderClienteView(container);
    }
  } catch (err) {
    console.error('EXCEPCIÓN DE RENDERIZADO (causa pantalla en blanco):', err);
    if (container) {
      container.innerHTML = `
        <div class="card" style="text-align:center; padding:48px 24px; color:var(--text-muted);">
          <div style="font-size:2rem; margin-bottom:12px;">🛠</div>
          <h3>Ocurrió un error al dibujar la pantalla</h3>
          <p style="font-size:0.85rem; margin-top:8px;"><code>${escapeHtml(err?.message || String(err))}</code></p>
          <button class="btn btn-primary" style="margin-top:12px;" onclick="forceRefreshAll()">🔄 Reintentar</button>
        </div>`;
    }
  }
}

function showRoleLoadingView() {
  const screenId = currentUser?.role === 'cliente' ? 'clienteScreen' : 'vendedorScreen';
  const container = document.getElementById(screenId);
  if (container) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 48px 24px; color: var(--text-muted);">
        <div style="font-size: 2rem; margin-bottom: 12px;">⏳</div>
        <h3>Cargando tu información…</h3>
        <p style="font-size: 0.9rem; margin-top: 8px;">Sincronizando clientes, fiados y mensajes.</p>
      </div>`;
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => registration.update())
      .catch(err => console.log('Error SW:', err));
  }
}

function initPWAInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const banner = document.getElementById('pwaBanner');
    if (banner) banner.style.display = 'flex';
  });
}

function installPWA() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  }
}

function saveSession(user) {
  currentUser = user;
  renderAppByRole();
  showRoleLoadingView();
}

async function logout() {
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch(e) {}
  }
  currentUser = null;
  showAuthScreen();
}

function switchAuthTab(mode) {
  authTabMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabRegister').classList.toggle('active', mode === 'register');
  
  document.getElementById('roleSelectorContainer').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('nameField').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('authSubmitBtn').innerText = mode === 'login' ? 'Iniciar Sesión' : 'Crear Cuenta';
}

function selectRegisterRole(role) {
  registerRole = role;
  document.getElementById('optVendedor').classList.toggle('selected', role === 'vendedor');
  document.getElementById('optCliente').classList.toggle('selected', role === 'cliente');
}

async function confirmLinkPin() {
  const pin = document.getElementById('linkPinValue').value.trim().toUpperCase();
  if (!pin) {
    alert('Ingresa un PIN válido.');
    return;
  }
  dbg('confirmLinkPin → intentando vincular con PIN:', pin);

  const { data: customerId, error } = await supabaseClient.rpc('link_my_customer', { p_access_code: pin });
  dbg('confirmLinkPin → link_my_customer:', { data: customerId, error });
  if (error || !customerId) {
    alert('No fue posible vincular el PIN: ' + (error?.message || 'código no encontrado'));
    return;
  }

  selectedCustomerId = customerId;
  currentUser.customerId = customerId;
  currentUser.pin = pin;

  try {
    const linked = await fetchLinkedCustomerRecord();
    if (linked) {
      currentUser.name = linked.name;
      appState.customers = [linked];
    }
    dbg('confirmLinkPin → registro vinculado:', linked);
  } catch (lookupErr) {
    console.warn('No se pudo leer el cliente vinculado:', lookupErr);
  }

  saveSession(currentUser);
  const result = await fetchDataFromSupabase();
  dbg('confirmLinkPin → fetchDataFromSupabase:', result);

  if (!result.ok) {
    console.error('Error de sincronización tras vincular el PIN:', result.error);
    alert('El PIN fue vinculado, pero no se pudieron cargar los movimientos.\n\n' +
          'Detalle: ' + result.error + '\n\n' +
          'Esto suele pasar si falta la migración en Supabase. Ejecuta supabase_production_migration.sql ' +
          'en el SQL Editor de Supabase y vuelve a ingresar el PIN. El código de acceso sigue válido.');
    renderCurrentRoleView();
    return;
  }

  closeModal('modalLinkPin');
  document.getElementById('linkPinValue').value = '';
  alert('¡Excelente! Tu cuenta ha sido vinculada y sincronizada.');
}

async function loginWithGoogle() {
  if (!supabaseClient) return alert('La autenticación segura no está disponible. Recarga la página.');
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}${window.location.pathname}`, queryParams: { prompt: 'select_account' } }
  });
  if (error) alert('No se pudo iniciar Google: ' + error.message);
}

async function confirmGoogleRole(role) {
  if (!pendingGoogleUser || isSavingRole) return;
  isSavingRole = true;
  const { error } = await supabaseClient.rpc('complete_my_profile', { p_role: role });
  if (error) {
    isSavingRole = false;
    return alert('No se pudo guardar tu rol: ' + error.message);
  }
  closeModal('modalGoogleRoleSelect');
  const user = pendingGoogleUser;
  pendingGoogleUser = null;
  isSavingRole = false;
  await handleSupabaseSession({ ...user, id: user.id, email: user.email, user_metadata: { full_name: user.name } });
}

async function handleSupabaseSession(supabaseUser) {
  if (sessionLoadUserId === supabaseUser.id && sessionLoadPromise) {
    return sessionLoadPromise;
  }

  sessionLoadUserId = supabaseUser.id;
  sessionLoadPromise = loadSupabaseSession(supabaseUser);
  try {
    return await sessionLoadPromise;
  } finally {
    if (sessionLoadUserId === supabaseUser.id) {
      sessionLoadPromise = null;
    }
  }
}

async function loadSupabaseSession(supabaseUser) {
  dbg('loadSupabaseSession → usuario:', supabaseUser.id, supabaseUser.email);
  const { data: profile, error } = await supabaseClient
    .from('profiles')
    .select('full_name, role, setup_complete')
    .eq('id', supabaseUser.id)
    .maybeSingle();
  if (error) {
    dbg('loadSupabaseSession → consulta profile ERROR:', error);
    alert('No se pudo cargar tu perfil: ' + error.message);
    showAuthScreen();
    return;
  }
  dbg('loadSupabaseSession → profile:', profile);

  const name = profile?.full_name || supabaseUser.user_metadata?.full_name || supabaseUser.email;
  const finalRole = profile?.setup_complete ? profile.role : null;
  dbg('loadSupabaseSession → finalRole:', finalRole);

  if (!finalRole) {
    pendingGoogleUser = {
      id: supabaseUser.id,
      name: name,
      email: supabaseUser.email,
      avatar: name.charAt(0).toUpperCase()
    };
    openModal('modalGoogleRoleSelect');
    return;
  }

  const userData = {
    id: supabaseUser.id,
    name: name,
    email: supabaseUser.email,
    role: finalRole,
    avatar: name.charAt(0).toUpperCase()
  };

  if (finalRole === 'cliente') {
    try {
      const linked = await fetchLinkedCustomerRecord();
      if (linked) {
        userData.customerId = linked.id;
        userData.name = linked.name || userData.name;
        selectedCustomerId = linked.id;
      }
      dbg('loadSupabaseSession → cliente vinculado:', linked);
    } catch (lookupErr) {
      console.warn('No se pudo restaurar el cliente vinculado:', lookupErr);
    }
  }

  saveSession(userData);
  const synchronized = await fetchDataFromSupabase();
  dbg('loadSupabaseSession → fetchDataFromSupabase:', synchronized);
  if (!synchronized.ok) {
    alert('No se pudieron cargar tus datos.\n\nDetalle: ' + (synchronized.error || 'Error desconocido') +
          '\n\nVerifica tu conexión y recarga la página.');
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPassword').value.trim();
  const name = document.getElementById('authName').value.trim() || email.split('@')[0];

  if (!supabaseClient) return alert('La autenticación segura no está disponible. Recarga la página.');
  {
    if (authTabMode === 'register') {
      const { data, error } = await supabaseClient.auth.signUp({
        email: email,
        password: pass,
        options: { data: { full_name: name } }
      });

      if (error) {
        alert('Error al registrarse en Supabase: ' + error.message);
      } else {
        if (data.session?.user) {
          const { error: roleError } = await supabaseClient.rpc('complete_my_profile', { p_role: registerRole });
          if (roleError) alert('La cuenta fue creada, pero no se pudo guardar el rol: ' + roleError.message);
          else await handleSupabaseSession(data.session.user);
        } else alert('Revisa tu correo para confirmar la cuenta antes de iniciar sesión.');
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: email, password: pass });
      dbg('signInWithPassword →', { error, user: data.user?.id });
      if (error) {
        alert('Error de autenticación Supabase: ' + error.message);
      } else if (data.user) {
        await handleSupabaseSession(data.user);
      }
    }
  }
}

function showAuthScreen() {
  currentUser = null;
  document.getElementById('authScreen').style.display = 'block';
  document.getElementById('vendedorScreen').style.display = 'none';
  document.getElementById('clienteScreen').style.display = 'none';
  document.getElementById('userHeaderBar').style.display = 'none';
}

function renderAppByRole() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('userHeaderBar').style.display = 'flex';
  document.getElementById('userName').innerText = currentUser.name;
  document.getElementById('userAvatar').innerText = currentUser.avatar || 'U';
  document.getElementById('userRoleTag').innerText = currentUser.role === 'vendedor' ? 'VENDEDOR' : 'CLIENTE';

  if (currentUser.role === 'vendedor') {
    document.getElementById('vendedorScreen').style.display = 'block';
    document.getElementById('clienteScreen').style.display = 'none';
  } else {
    document.getElementById('vendedorScreen').style.display = 'none';
    document.getElementById('clienteScreen').style.display = 'block';
    if (currentUser.customerId) selectedCustomerId = currentUser.customerId;
  }
}

function getCustomerBalance(customerId) {
  const customerItems = appState.items.filter(i => i.customerId === customerId);
  const customerPayments = appState.payments.filter(p => p.customerId === customerId);
  const totalItems = customerItems.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
  const totalPayments = customerPayments.reduce((sum, p) => sum + p.amount, 0);
  return Math.max(0, totalItems - totalPayments);
}

function getStoreMetrics() {
  let totalFiado = 0;
  let totalCobrado = 0;
  appState.customers.forEach(c => totalFiado += getCustomerBalance(c.id));
  appState.payments.forEach(p => totalCobrado += p.amount);
  return {
    totalFiado: totalFiado.toFixed(2),
    totalCobrado: totalCobrado.toFixed(2),
    activeCustomers: appState.customers.length
  };
}

// AGREGAR CLIENTE (SUPABASE & MEMORIA LOCAL)
async function createCustomer() {
  const nameInput = document.getElementById('newCustName');
  const phoneInput = document.getElementById('newCustPhone');
  const codeInput = document.getElementById('newCustCode');
  const notesInput = document.getElementById('newCustNotes');

  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  // PIN alfanumérico de 6 caracteres — mucho más difícil de adivinar que 4 dígitos
  const generateSecurePin = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin 0,O,1,I para evitar confusiones
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  };
  const code = (codeInput.value.trim() || generateSecurePin()).toUpperCase();
  const notes = notesInput.value.trim();

  if (!name || !phone) {
    alert('Ingresa el nombre y teléfono del cliente.');
    return;
  }

  let createdCustomer;
  try {
      let storeId = null;
      const { data: stores, error: storesErr } = await supabaseClient.from('stores').select('id').eq('owner_id', currentUser.id).limit(1);
      if (storesErr) throw storesErr;
      dbg('createCustomer → tiendas del vendedor:', stores);

      if (stores && stores.length > 0) {
        storeId = stores[0].id;
      } else {
        const { data: newStore, error: storeErr } = await supabaseClient.from('stores').insert([{
          owner_id: currentUser.id,
          store_name: `${currentUser.name} - Tienda`,
          owner_name: currentUser.name,
          phone: phone
        }]).select('id');

        if (newStore && newStore.length > 0) storeId = newStore[0].id;
        if (storeErr) throw storeErr;
        dbg('createCustomer → tienda creada:', storeId);
      }

      if (storeId) {
        const { data: createdCust, error: custErr } = await supabaseClient.from('customers').insert([{
          store_id: storeId,
          full_name: name,
          phone: phone,
          access_code: code,
          notes: notes
        }]).select('*');

        if (custErr) throw custErr;
        if (!createdCust?.length) throw new Error('No se recibió el cliente creado.');
        createdCustomer = createdCust[0];
        dbg('createCustomer → cliente insertado:', createdCustomer);
      } else throw new Error('No se pudo crear la tienda.');
  } catch(e) {
    console.error('Error general al insertar cliente:', e);
    return alert('No se pudo registrar el cliente: ' + e.message);
  }

  selectedCustomerId = createdCustomer.id;

  nameInput.value = '';
  phoneInput.value = '';
  codeInput.value = '';
  notesInput.value = '';

  closeModal('modalNewCustomer');

  const result = await fetchDataFromSupabase();
  dbg('createCustomer → fetchDataFromSupabase:', result);
  if (!result.ok) {
    console.error('No se pudo recargar la lista tras registrar el cliente:', result.error);
    return alert('El cliente fue registrado en la base de datos, pero no se pudo actualizar la lista.\n\n' +
                 'Detalle: ' + result.error + '\n\nRecarga la página para verlo.');
  }
  alert(`¡Cliente "${name}" registrado correctamente! PIN asignado: ${code}`);
}

function openAddItemModal(customerId) {
  selectedCustomerId = customerId;
  openModal('modalAddItem');
}

function selectCustomer(customerId) {
  selectedCustomerId = customerId;
  renderVendedorView(document.getElementById('vendedorScreen'));
}

function filterCustomers() {
  const query = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
  document.querySelectorAll('#customerList .customer-card').forEach((card) => {
    card.style.display = card.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ANOTAR PRODUCTO FIADO (SUPABASE & LOCAL) — solo vendedores
async function createFiadoItem() {
  if (!currentUser || currentUser.role !== 'vendedor') {
    alert('Acción no permitida.');
    return;
  }
  const nameInput = document.getElementById('itemName');
  const qtyInput = document.getElementById('itemQty');
  const priceInput = document.getElementById('itemPrice');

  const name = nameInput.value.trim();
  const qty = parseFloat(qtyInput.value) || 1;
  const unitPrice = parseFloat(priceInput.value);

  if (!name || isNaN(unitPrice) || unitPrice < 0) {
    alert('Ingresa un nombre y precio válido.');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  try {
      let { data: account } = await supabaseClient.from('fiado_accounts').select('id').eq('customer_id', selectedCustomerId).maybeSingle();
      
      if (!account) {
        const { data: stores, error: storeErr } = await supabaseClient.from('stores').select('id').eq('owner_id', currentUser.id).limit(1);
        if (storeErr) throw storeErr;
        const storeId = stores && stores.length > 0 ? stores[0].id : null;
        if (storeId) {
          const { data: newAcc, error: accountErr } = await supabaseClient.from('fiado_accounts').insert([{
            customer_id: selectedCustomerId,
            store_id: storeId
          }]).select('id');
          if (accountErr) throw accountErr;
          if (newAcc && newAcc.length > 0) account = newAcc[0];
        }
      }

      if (account) {
        const { data: newItem, error: itemErr } = await supabaseClient.from('fiado_items').insert([{
          account_id: account.id,
          product_name: name,
          quantity: qty,
          unit_price: unitPrice,
          item_date: today
        }]).select('id');

        if (itemErr) throw itemErr;
      } else throw new Error('No se pudo crear la cuenta fiada.');
  } catch(e) {
    console.error('Error insertando fiado:', e);
    return alert('No se pudo guardar el producto: ' + e.message);
  }
  await sendChatMessage('vendedor', `📦 Fiado anotado: ${qty}x ${name} (S/ ${(qty * unitPrice).toFixed(2)})`);
  nameInput.value = '';
  priceInput.value = '';

  closeModal('modalAddItem');
  await fetchDataFromSupabase();
}

function openPaymentModal(customerId) {
  selectedCustomerId = customerId;
  openModal('modalPayment');
}

// REGISTRAR ABONO / PAGO (SUPABASE & LOCAL) — solo vendedores
async function createPayment() {
  if (!currentUser || currentUser.role !== 'vendedor') {
    alert('Acción no permitida.');
    return;
  }
  const amountInput = document.getElementById('payAmount');
  const amount = parseFloat(amountInput.value);
  const method = document.getElementById('payMethod').value;

  if (isNaN(amount) || amount <= 0) {
    alert('Ingresa un monto de abono válido.');
    return;
  }

  try {
      let { data: account } = await supabaseClient.from('fiado_accounts').select('id').eq('customer_id', selectedCustomerId).maybeSingle();
      if (account) {
        const { error: paymentErr } = await supabaseClient.from('payments').insert([{
          account_id: account.id,
          amount: amount,
          payment_method: method
        }]).select('id');
        if (paymentErr) throw paymentErr;
      } else throw new Error('No existe una cuenta fiada para este cliente.');
  } catch(e) {
    console.error('Error guardando pago:', e);
    return alert('No se pudo registrar el pago: ' + e.message);
  }
  await sendChatMessage('vendedor', `💵 Abono registrado: S/ ${amount.toFixed(2)} vía ${method}`);
  amountInput.value = '';
  closeModal('modalPayment');
  await fetchDataFromSupabase();
}

async function sendPaymentReminder(customerId) {
  const balance = getCustomerBalance(customerId);
  const customer = appState.customers.find(c => c.id === customerId);
  if (balance <= 0) {
    alert('El cliente está al día.');
    return;
  }

  const text = `Hola ${customer.name}, le recordamos amablemente que su saldo pendiente es de S/ ${balance.toFixed(2)}. ¡Gracias!`;
  await sendChatMessage('vendedor', text);
  alert('Recordatorio enviado al chat.');
}

// CORROBORAR PRODUCTO (CLIENTE)
async function confirmItem(itemId) {
  const item = appState.items.find(i => i.id === itemId);
  if (item) {
    const { error } = await supabaseClient.from('fiado_items').update({ verified_by_customer: true }).eq('id', itemId);
    if (error) return alert('No se pudo corroborar el producto: ' + error.message);
    await sendChatMessage('cliente', `✓ Corroboré la compra de: ${item.name}`);
    await fetchDataFromSupabase();
  }
}

function openDiscrepancyModal() { openModal('modalDiscrepancy'); }

function openLinkPinModal() { openModal('modalLinkPin'); }

// ENVIAR REPORTAR DISCREPANCIA (CLIENTE)
async function submitDiscrepancy() {
  if (!selectedCustomerId) return alert('Primero vincula el PIN que te entregó tu tendero.');
  const input = document.getElementById('discComment');
  const text = input.value.trim();
  if (!text) {
    alert('Explica el detalle de la observación.');
    return;
  }

  const { error } = await supabaseClient.from('discrepancies').insert([{
    customer_id: selectedCustomerId, comment: text, status: 'pendiente'
  }]);
  if (error) return alert('No se pudo enviar el reporte: ' + error.message);

  await sendChatMessage('cliente', `⚠️ Reporte de observación sobre la cuenta: "${text}"`);

  input.value = '';
  closeModal('modalDiscrepancy');
  await fetchDataFromSupabase();
  alert('Reporte enviado al vendedor por el chat.');
}

// ELIMINAR ÍTEM — solo vendedores autenticados
async function deleteItem(itemId) {
  if (!currentUser || currentUser.role !== 'vendedor') {
    alert('Acción no permitida.');
    return;
  }
  if (confirm('¿Eliminar este ítem del historial fiado?')) {
    const { error } = await supabaseClient.from('fiado_items').delete().eq('id', itemId);
    if (error) return alert('No se pudo eliminar el ítem: ' + error.message);
    await fetchDataFromSupabase();
  }
}

// ENVIAR MENSAJE DE CHAT (SUPABASE & LOCAL)
async function sendChatMessage(overrideRole, customText) {
  const input = document.getElementById('chatInput');
  const text = customText || (input ? input.value.trim() : '');
  if (!text) return;

  const senderRole = overrideRole || (currentUser ? currentUser.role : 'vendedor');
  if (!selectedCustomerId) return alert('Selecciona una cuenta de cliente antes de enviar un mensaje.');
  const { data: customer, error: customerErr } = await supabaseClient.from('customers').select('store_id').eq('id', selectedCustomerId).single();
  if (customerErr) return alert('No se pudo identificar la cuenta: ' + customerErr.message);
  const { error } = await supabaseClient.from('chat_messages').insert([{
    customer_id: selectedCustomerId, store_id: customer.store_id, sender_type: senderRole, message: text
  }]);
  if (error) return alert('No se pudo enviar el mensaje: ' + error.message);

  if (input) input.value = '';
  await fetchDataFromSupabase();
}

function scrollChatToBottom() {
  setTimeout(() => {
    const container = document.getElementById('chatContainer');
    if (container) container.scrollTop = container.scrollHeight;
  }, 100);
}

// RENDERIZADO VENDEDOR Y CLIENTE
function renderVendedorView(container) {
  dbg('renderVendedorView → customers en state:', appState.customers.length, '| selected:', selectedCustomerId);
  const metrics = getStoreMetrics();
  const activeCustomer = appState.customers.find(c => c.id === selectedCustomerId) || appState.customers[0];
  if (activeCustomer) selectedCustomerId = activeCustomer.id;

  const activeCustomerBalance = activeCustomer ? getCustomerBalance(activeCustomer.id) : 0;
  const activeItems = activeCustomer ? appState.items.filter(i => i.customerId === selectedCustomerId) : [];
  const activeChat = activeCustomer ? appState.chat.filter(m => m.customerId === selectedCustomerId) : [];

  container.innerHTML = `
    ${renderLoadErrorBanner()}
    <div class="metrics-grid">
      <div class="metric-card accent">
        <div class="metric-icon">💰</div>
        <div class="metric-info">
          <label>Total por Cobrar (Fiado)</label>
          <div class="value highlight">S/ ${metrics.totalFiado}</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">✅</div>
        <div class="metric-info">
          <label>Total Cobrado</label>
          <div class="value">S/ ${metrics.totalCobrado}</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">👥</div>
        <div class="metric-info">
          <label>Clientes Registrados</label>
          <div class="value">${metrics.activeCustomers}</div>
        </div>
      </div>
    </div>

    <div class="section-header">
      <div class="section-title">👥 Listado de Clientes</div>
      <div style="display: flex; gap: 10px; align-items: center; width: 100%; max-width: 500px;">
        <div class="search-bar">
          <span class="search-icon">🔍</span>
          <input type="text" id="searchInput" class="search-input" placeholder="Buscar cliente..." onkeyup="filterCustomers()">
        </div>
        <button class="btn btn-primary" onclick="openModal('modalNewCustomer')">
          <span>+</span> Nuevo Cliente
        </button>
      </div>
    </div>

    <div class="customer-list" id="customerList">
      ${appState.customers.length === 0 ? `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          <div style="font-size: 2.5rem; margin-bottom: 10px;">👥</div>
          <h3>No tienes clientes registrados aún</h3>
          <p style="font-size: 0.9rem; margin-top: 6px;">Haz clic en <strong>"+ Nuevo Cliente"</strong> para registrar a tu primer cliente.</p>
        </div>
      ` : appState.customers.map(c => {
        const balance = getCustomerBalance(c.id);
        const isSelected = c.id === selectedCustomerId;
        return `
          <div class="customer-card ${isSelected ? 'selected' : ''}" style="${isSelected ? 'border-color: var(--primary-pastel); background: var(--bg-subtle);' : ''}">
            <div class="customer-card-header">
              <div style="display: flex; gap: 12px; align-items: center;">
                <div class="customer-avatar">${escapeHtml(c.name.charAt(0))}</div>
                <div>
                  <div class="customer-name">${escapeHtml(c.name)}</div>
                  <div class="customer-phone">📱 ${escapeHtml(c.phone)}</div>
                </div>
              </div>
              <span class="customer-code-badge">PIN: ${escapeHtml(c.code)}</span>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 8px;">
              <div>
                <span class="status-pill ${balance > 0 ? 'pendiente' : 'al_dia'}">
                  ${balance > 0 ? 'Pendiente' : 'Al día'}
                </span>
              </div>
              <div class="debt-badge ${balance === 0 ? 'zero' : ''}">
                S/ ${balance.toFixed(2)}
              </div>
            </div>

            <div class="customer-actions">
              <button class="btn btn-secondary btn-sm" style="flex: 1;" onclick="selectCustomer('${c.id}')">
                📋 Ver Cuenta
              </button>
              <button class="btn btn-primary btn-sm" onclick="openAddItemModal('${c.id}')">
                + Fiar Producto
              </button>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    ${activeCustomer ? `
      <div class="card" style="margin-top: 30px;">
        <div class="section-header">
          <div>
            <div class="section-title">
              <span>📋 Cuenta de: ${escapeHtml(activeCustomer.name)}</span>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-muted);">PIN de acceso para el cliente: <strong>${escapeHtml(activeCustomer.code)}</strong></p>
          </div>
          <div style="display: flex; gap: 10px;">
            <button class="btn btn-secondary btn-sm" onclick="openPaymentModal('${activeCustomer.id}')">
              💵 Registrar Abono / Pago
            </button>
            <button class="btn btn-primary btn-sm" onclick="sendPaymentReminder('${activeCustomer.id}')">
              📲 Enviar Recordatorio
            </button>
          </div>
        </div>

        <div class="table-responsive">
          <table class="custom-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto / Descripción</th>
                <th>Cant.</th>
                <th>P. Unit</th>
                <th>Total</th>
                <th>Estado Cliente</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${activeItems.length === 0 ? `
                <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No hay productos fiados registrados en esta cuenta.</td></tr>
              ` : activeItems.map(item => `
                <tr>
                  <td>${escapeHtml(item.date)}</td>
                  <td><strong>${escapeHtml(item.name)}</strong></td>
                  <td>${escapeHtml(String(item.qty))}</td>
                  <td>S/ ${item.unitPrice.toFixed(2)}</td>
                  <td><strong>S/ ${(item.qty * item.unitPrice).toFixed(2)}</strong></td>
                  <td>
                    <span class="item-verify-badge ${item.verified ? 'ok' : 'pending'}">
                      ${item.verified ? '✓ Corroborado' : '⏳ Por revisar'}
                    </span>
                  </td>
                  <td>
                    <button class="btn btn-outline btn-sm" style="color: var(--status-danger);" onclick="deleteItem('${item.id}')">🗑️</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-top: 24px;">
          <div class="section-title" style="margin-bottom: 12px;">💬 Chat con ${escapeHtml(activeCustomer.name)}</div>
          <div class="chat-box">
            <div class="chat-messages" id="chatContainer">
              ${activeChat.length === 0 ? `
                <div class="chat-bubble sistema">Inicio de la conversación con el cliente.</div>
              ` : activeChat.map(msg => `
                <div class="chat-bubble ${escapeHtml(msg.sender)}">
                  ${escapeHtml(msg.text)}
                  <span class="timestamp">${escapeHtml(msg.time)}</span>
                </div>
              `).join('')}
            </div>
            <div class="chat-input-area">
              <input type="text" id="chatInput" class="chat-input" placeholder="Escribe un mensaje o cobro..." onkeypress="if(event.key==='Enter') sendChatMessage('vendedor')">
              <button class="btn btn-primary" onclick="sendChatMessage('vendedor')">Enviar</button>
            </div>
          </div>
        </div>
      </div>
    ` : ''}
  `;
  scrollChatToBottom();
}

function renderClienteView(container) {
  dbg('renderClienteView → customers en state:', appState.customers.length, '| selected:', selectedCustomerId, '| customerId set:', currentUser?.customerId || null);
  let activeCustomer = appState.customers.find(c => c.id === selectedCustomerId) || appState.customers[0];

  if (!activeCustomer && currentUser?.customerId) {
    activeCustomer = appState.customers.find(c => c.id === currentUser.customerId) || null;
    if (activeCustomer) selectedCustomerId = activeCustomer.id;
  }

  if (activeCustomer) selectedCustomerId = activeCustomer.id;

  const balance = activeCustomer ? getCustomerBalance(activeCustomer.id) : 0;
  const activeItems = activeCustomer ? appState.items.filter(i => i.customerId === selectedCustomerId) : [];
  const activeChat = activeCustomer ? appState.chat.filter(m => m.customerId === selectedCustomerId) : [];

  if (!activeCustomer) {
    container.innerHTML = `
      ${renderLoadErrorBanner()}
      <div class="customer-welcome-card">
        <h2>Hola, ${escapeHtml(currentUser.name)} 👋</h2>
        ${currentUser.customerId ? `
          <p>Tu cuenta <strong>sí</strong> está vinculada (ID: <code style="font-size:0.7rem;">${escapeHtml(currentUser.customerId)}</code>),
          pero no se encontró tu registro al cargar los datos. Presiona el botón para reintentar o vuelve a vincular tu PIN.</p>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;">
            <button class="btn btn-primary" onclick="forceRefreshAll()">🔄 Reintentar</button>
            <button class="btn btn-secondary" onclick="openLinkPinModal()">🔗 Vincular mi PIN</button>
          </div>
        ` : `
          <p>Para ver tu cuenta fiada, vincula el PIN seguro que te entregó tu tendero.</p>
          <button class="btn btn-secondary" onclick="openLinkPinModal()">🔗 Vincular mi PIN</button>
        `}
      </div>`;
    return;
  }

  container.innerHTML = `
    ${renderLoadErrorBanner()}
    <div class="customer-welcome-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div>
          <h2>Hola, ${escapeHtml(currentUser ? currentUser.name : (activeCustomer ? activeCustomer.name : 'Cliente'))} 👋</h2>
          <p>Consulta el historial de tus productos fiados en tu tienda de confianza.</p>
        </div>
        <div style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: var(--radius-md); text-align: right;">
          <span style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Tu Deuda Total</span>
          <div style="font-size: 1.8rem; font-weight: 800;">S/ ${balance.toFixed(2)}</div>
        </div>
      </div>

      <div style="margin-top: 14px; display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.15); padding: 10px 16px; border-radius: var(--radius-md); flex-wrap: wrap; gap: 10px;">
        <div>
          <span style="font-size: 0.85rem; font-weight: 700;">🔑 PIN de Cuenta Vinculada:</span>
          <strong style="font-size: 1rem; margin-left: 6px;">${activeCustomer ? escapeHtml(activeCustomer.code || 'Ninguno') : 'Ninguno'}</strong>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openLinkPinModal()">
          🔗 Ingresar / Cambiar PIN
        </button>
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <div class="section-title">🛒 Productos Fiados en tu Cuenta</div>
        <button class="btn btn-secondary btn-sm" onclick="openDiscrepancyModal()">
          ⚠️ Reportar Error en Precio / Cantidad
        </button>
      </div>

      <div class="table-responsive">
        <table class="custom-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Precio Unit.</th>
              <th>Total Fiado</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${activeItems.length === 0 ? `
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Tu cuenta está vinculada. Aún no hay productos fiados registrados; cuando tu tendero anote uno, aparecerá aquí.</td></tr>
            ` : activeItems.map(item => `
              <tr>
                <td>${escapeHtml(item.date)}</td>
                <td><strong>${escapeHtml(item.name)}</strong></td>
                <td>${escapeHtml(String(item.qty))}</td>
                <td>S/ ${item.unitPrice.toFixed(2)}</td>
                <td><strong style="color: var(--primary-deep);">S/ ${(item.qty * item.unitPrice).toFixed(2)}</strong></td>
                <td>
                  <span class="item-verify-badge ${item.verified ? 'ok' : 'pending'}">
                    ${item.verified ? '✓ Corroborado' : '⏳ Por revisar'}
                  </span>
                </td>
                <td>
                  ${!item.verified ? `
                    <button class="btn btn-primary btn-sm" onclick="confirmItem('${item.id}')">
                      Conforme ✓
                    </button>
                  ` : `
                    <span style="font-size: 0.8rem; color: var(--status-success); font-weight: 700;">Aceptado</span>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-bottom: 12px;">💬 Chat con la Tienda</div>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">Coordina pagos por Yape, solicita aclaraciones o envía comprobantes.</p>
      
      <div class="chat-box">
        <div class="chat-messages" id="chatContainer">
          ${activeChat.length === 0 ? `
            <div class="chat-bubble sistema">Puedes escribirle directamente a la tienda aquí.</div>
          ` : activeChat.map(msg => `
            <div class="chat-bubble ${escapeHtml(msg.sender)}">
              ${escapeHtml(msg.text)}
              <span class="timestamp">${escapeHtml(msg.time)}</span>
            </div>
          `).join('')}
        </div>
        <div class="chat-input-area">
          <input type="text" id="chatInput" class="chat-input" placeholder="Escribe tu mensaje a la tienda..." onkeypress="if(event.key==='Enter') sendChatMessage('cliente')">
          <button class="btn btn-primary" onclick="sendChatMessage('cliente')">Enviar</button>
        </div>
      </div>
    </div>
  `;
  scrollChatToBottom();
}
