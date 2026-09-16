/* ==========================================================================
   LÓGICA CONEXIÓN CON SUPABASE EN TIEMPO REAL - "HOY FÍO MAÑANA NO"
   ========================================================================== */

const INITIAL_DATA = {
  store: {
    name: 'Mi Tienda / Bodega',
    owner: '',
    phone: ''
  },
  customers: [],
  items: [],
  payments: [],
  chat: []
};

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

function loadState() {
  const saved = localStorage.getItem('hoyfio_db');
  if (saved) {
    try { 
      const parsed = JSON.parse(saved);
      if (parsed.customers && parsed.customers.some(c => c.id === 'c1')) {
        localStorage.removeItem('hoyfio_db');
        return INITIAL_DATA;
      }
      return parsed; 
    } catch(e) {}
  }
  return INITIAL_DATA;
}

function saveState() {
  localStorage.setItem('hoyfio_db', JSON.stringify(appState));
}

function getGoogleUsersRegistry() {
  const saved = localStorage.getItem('hoyfio_google_users');
  if (saved) {
    try { return JSON.parse(saved); } catch(e) {}
  }
  return {};
}

function saveGoogleUserRole(email, role) {
  const registry = getGoogleUsersRegistry();
  registry[email.toLowerCase()] = role;
  localStorage.setItem('hoyfio_google_users', JSON.stringify(registry));
}

let appState = loadState();
let currentUser = null;
let pendingGoogleUser = null;
let authTabMode = 'login';
let registerRole = 'vendedor';
let selectedCustomerId = null;
let deferredPrompt = null;
let supabaseClient = null;

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  initSupabaseClient();
  registerServiceWorker();
  initPWAInstall();
  checkSavedSession();
});

function initSupabaseClient() {
  const cfgUrl = SUPABASE_CONFIG.url;
  const cfgKey = SUPABASE_CONFIG.anonKey;
  const statusBadge = document.getElementById('supabaseStatusDot');

  if (document.getElementById('cfgSupabaseUrl')) {
    document.getElementById('cfgSupabaseUrl').value = cfgUrl;
    document.getElementById('cfgSupabaseKey').value = cfgKey;
  }

  if (window.supabase && cfgUrl && cfgKey) {
    try {
      supabaseClient = window.supabase.createClient(cfgUrl, cfgKey);
      if (statusBadge) statusBadge.innerText = '🟢 Supabase Conectado';
      
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (session && session.user) {
          handleSupabaseSession(session.user);
        } else if (event === 'SIGNED_OUT') {
          showAuthScreen();
        }
      });

      fetchDataFromSupabase();
    } catch(err) {
      console.error('Error al inicializar Supabase:', err);
      if (statusBadge) statusBadge.innerText = '⚠️ Error Supabase';
    }
  } else {
    if (statusBadge) statusBadge.innerText = '🟡 Almacenamiento Local';
  }
}

// CARGA REAL DE DATOS DESDE SUPABASE (CLIENTES, ÍTEMS, PAGOS, CHAT)
async function fetchDataFromSupabase() {
  if (!supabaseClient) return;

  try {
    const { data: customersData, error: custErr } = await supabaseClient.from('customers').select('*');
    if (custErr) console.error('Error consultando clientes:', custErr);

    if (customersData) {
      appState.customers = customersData.map(c => ({
        id: c.id,
        name: c.full_name,
        phone: c.phone,
        code: c.access_code,
        notes: c.notes || ''
      }));
    }

    const { data: itemsData } = await supabaseClient.from('fiado_items').select('*');
    if (itemsData) {
      appState.items = itemsData.map(i => ({
        id: i.id,
        customerId: i.account_id,
        name: i.product_name,
        qty: parseFloat(i.quantity),
        unitPrice: parseFloat(i.unit_price),
        date: i.item_date,
        verified: i.verified_by_customer
      }));
    }

    const { data: paymentsData } = await supabaseClient.from('payments').select('*');
    if (paymentsData) {
      appState.payments = paymentsData.map(p => ({
        id: p.id,
        customerId: p.account_id,
        amount: parseFloat(p.amount),
        date: p.created_at ? p.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
        method: p.payment_method
      }));
    }

    const { data: chatData } = await supabaseClient.from('chat_messages').select('*').order('created_at', { ascending: true });
    if (chatData) {
      appState.chat = chatData.map(m => ({
        id: m.id,
        customerId: m.customer_id,
        sender: m.sender_type,
        text: m.message,
        time: m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      }));
    }

    saveState();
    if (currentUser) {
      if (currentUser.role === 'vendedor') {
        renderVendedorView(document.getElementById('vendedorScreen'));
      } else {
        renderClienteView(document.getElementById('clienteScreen'));
      }
    }
  } catch(e) {
    console.error('Error cargando datos de Supabase:', e);
  }
}

function saveSupabaseFromModal() {
  const url = document.getElementById('cfgSupabaseUrl').value.trim();
  const key = document.getElementById('cfgSupabaseKey').value.trim();

  if (!url || !key) {
    alert('Ingresa la URL y la Anon Key de tu proyecto en Supabase.');
    return;
  }
  saveSupabaseCredentials(url, key);
}

function clearSupabaseConfig() {
  localStorage.removeItem('supabase_url');
  localStorage.removeItem('supabase_key');
  logout();
  window.location.reload();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('Error SW:', err));
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

function checkSavedSession() {
  const savedUser = sessionStorage.getItem('hoyfio_user');
  if (savedUser) {
    try {
      currentUser = JSON.parse(savedUser);
      renderAppByRole();
      return;
    } catch(e) {}
  }
  showAuthScreen();
}

function saveSession(user) {
  currentUser = user;
  sessionStorage.setItem('hoyfio_user', JSON.stringify(user));
  renderAppByRole();
}

async function logout() {
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch(e) {}
  }
  currentUser = null;
  sessionStorage.removeItem('hoyfio_user');
  localStorage.removeItem('hoyfio_user');
  showAuthScreen();
}

function switchAuthTab(mode) {
  authTabMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabPin').classList.toggle('active', mode === 'pin');
  document.getElementById('tabRegister').classList.toggle('active', mode === 'register');
  
  const pinContainer = document.getElementById('pinLoginFormContainer');
  const standardAuth = document.getElementById('standardAuthContainer');

  if (mode === 'pin') {
    pinContainer.style.display = 'block';
    standardAuth.style.display = 'none';
  } else {
    pinContainer.style.display = 'none';
    standardAuth.style.display = 'block';
    document.getElementById('roleSelectorContainer').style.display = mode === 'register' ? 'block' : 'none';
    document.getElementById('nameField').style.display = mode === 'register' ? 'block' : 'none';
    document.getElementById('authSubmitBtn').innerText = mode === 'login' ? 'Iniciar Sesión' : 'Crear Cuenta';
  }
}

function selectRegisterRole(role) {
  registerRole = role;
  document.getElementById('optVendedor').classList.toggle('selected', role === 'vendedor');
  document.getElementById('optCliente').classList.toggle('selected', role === 'cliente');
}

async function loginWithClientPin() {
  const pin = document.getElementById('clientPinInput').value.trim();
  if (!pin) {
    alert('Por favor ingresa el PIN proporcionado por tu tendero.');
    return;
  }

  let customerFound = null;

  if (supabaseClient) {
    const { data } = await supabaseClient
      .from('customers')
      .select('*')
      .eq('access_code', pin)
      .maybeSingle();

    if (data) customerFound = data;
  }

  if (!customerFound) {
    customerFound = appState.customers.find(c => c.code === pin);
  }

  if (customerFound) {
    selectedCustomerId = customerFound.id;
    saveSession({
      name: customerFound.full_name || customerFound.name,
      role: 'cliente',
      pin: pin,
      customerId: customerFound.id,
      avatar: (customerFound.full_name || customerFound.name).charAt(0).toUpperCase()
    });
  } else {
    alert('No se encontró ningún cliente registrado con ese PIN. Solicita a tu tendero que te proporcione tu PIN de acceso.');
  }
}

async function confirmLinkPin() {
  const pin = document.getElementById('linkPinValue').value.trim();
  if (!pin) {
    alert('Ingresa un PIN válido.');
    return;
  }

  let customerFound = appState.customers.find(c => c.code === pin);

  if (supabaseClient && !customerFound) {
    const { data } = await supabaseClient
      .from('customers')
      .select('*')
      .eq('access_code', pin)
      .maybeSingle();
      
    if (data) customerFound = data;
  }

  if (customerFound) {
    selectedCustomerId = customerFound.id;
    if (currentUser) {
      currentUser.customerId = customerFound.id;
      currentUser.pin = pin;
      currentUser.name = customerFound.full_name || customerFound.name;
      saveSession(currentUser);
    }
    closeModal('modalLinkPin');
    renderClienteView(document.getElementById('clienteScreen'));
    alert(`¡Excelente! Tu cuenta ha sido vinculada con ${customerFound.full_name || customerFound.name}.`);
  } else {
    alert('El PIN ingresado no coincide con ningún cliente registrado. Revisa el código con tu tendero.');
  }
}

async function loginWithGoogle() {
  if (supabaseClient) {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) alert('Error Google OAuth Supabase: ' + error.message);
  } else {
    const simulatedEmail = prompt('Ingresa tu correo de Google para ingresar:', 'usuario.google@gmail.com');
    if (!simulatedEmail) return;

    const googleRegistry = getGoogleUsersRegistry();
    const existingRole = googleRegistry[simulatedEmail.toLowerCase()];

    if (existingRole) {
      saveSession({
        name: simulatedEmail.split('@')[0],
        email: simulatedEmail,
        role: existingRole,
        avatar: simulatedEmail.charAt(0).toUpperCase()
      });
    } else {
      pendingGoogleUser = {
        name: simulatedEmail.split('@')[0],
        email: simulatedEmail,
        avatar: simulatedEmail.charAt(0).toUpperCase()
      };
      openModal('modalGoogleRoleSelect');
    }
  }
}

function confirmGoogleRole(role) {
  if (pendingGoogleUser) {
    saveGoogleUserRole(pendingGoogleUser.email, role);
    const fullUser = { ...pendingGoogleUser, role: role };
    closeModal('modalGoogleRoleSelect');
    pendingGoogleUser = null;
    saveSession(fullUser);
  }
}

function handleSupabaseSession(supabaseUser) {
  const existingRole = supabaseUser.user_metadata?.role;
  const name = supabaseUser.user_metadata?.full_name || supabaseUser.email;
  const googleRegistry = getGoogleUsersRegistry();
  const savedLocalRole = googleRegistry[supabaseUser.email.toLowerCase()];
  const finalRole = existingRole || savedLocalRole;

  if (finalRole) {
    saveSession({
      id: supabaseUser.id,
      name: name,
      email: supabaseUser.email,
      role: finalRole,
      avatar: name.charAt(0).toUpperCase()
    });
  } else {
    pendingGoogleUser = {
      id: supabaseUser.id,
      name: name,
      email: supabaseUser.email,
      avatar: name.charAt(0).toUpperCase()
    };
    openModal('modalGoogleRoleSelect');
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPassword').value.trim();
  const name = document.getElementById('authName').value.trim() || email.split('@')[0];

  if (supabaseClient) {
    if (authTabMode === 'register') {
      const { data, error } = await supabaseClient.auth.signUp({
        email: email,
        password: pass,
        options: { data: { full_name: name, role: registerRole } }
      });

      if (error) {
        alert('Error al registrarse en Supabase: ' + error.message);
      } else {
        alert('¡Cuenta registrada en Supabase!');
        if (data.user) {
          saveSession({ id: data.user.id, name, email, role: registerRole, avatar: name.charAt(0).toUpperCase() });
        }
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: email, password: pass });
      if (error) {
        alert('Error de autenticación Supabase: ' + error.message);
      } else if (data.user) {
        handleSupabaseSession(data.user);
      }
    }
  } else {
    if (authTabMode === 'register') {
      saveSession({ name, email, role: registerRole, avatar: name.charAt(0).toUpperCase() });
    } else {
      const existingCust = appState.customers.find(c => c.code === pass || c.email === email || c.phone === email);
      if (existingCust) {
        selectedCustomerId = existingCust.id;
        saveSession({ name: existingCust.name, email, role: 'cliente', customerId: existingCust.id, avatar: existingCust.name.charAt(0) });
      } else {
        saveSession({ name: name || 'Mi Tienda', email, role: 'vendedor', avatar: (name || 'V').charAt(0) });
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
    renderVendedorView(document.getElementById('vendedorScreen'));
  } else {
    document.getElementById('vendedorScreen').style.display = 'none';
    document.getElementById('clienteScreen').style.display = 'block';
    if (currentUser.customerId) selectedCustomerId = currentUser.customerId;
    renderClienteView(document.getElementById('clienteScreen'));
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
  const code = codeInput.value.trim() || generateSecurePin();
  const notes = notesInput.value.trim();

  if (!name || !phone) {
    alert('Ingresa el nombre y teléfono del cliente.');
    return;
  }

  let newId = 'c_' + Date.now();

  if (supabaseClient) {
    try {
      let storeId = null;
      const { data: stores } = await supabaseClient.from('stores').select('id').limit(1);
      
      if (stores && stores.length > 0) {
        storeId = stores[0].id;
      } else {
        const { data: newStore, error: storeErr } = await supabaseClient.from('stores').insert([{
          store_name: currentUser ? (currentUser.name + ' - Tienda') : 'Mi Tienda',
          owner_name: currentUser ? currentUser.name : 'Vendedor',
          phone: phone
        }]).select('id');
        
        if (newStore && newStore.length > 0) storeId = newStore[0].id;
        if (storeErr) console.error('Error creando tienda en Supabase:', storeErr);
      }

      if (storeId) {
        const { data: createdCust, error: custErr } = await supabaseClient.from('customers').insert([{
          store_id: storeId,
          full_name: name,
          phone: phone,
          access_code: code,
          notes: notes
        }]).select('*');

        if (custErr) {
          console.error('Error insertando cliente en Supabase:', custErr);
          alert('Atención al guardar en Supabase: ' + custErr.message);
        } else if (createdCust && createdCust.length > 0) {
          newId = createdCust[0].id;
          // No se loguean datos del cliente por seguridad
        }
      }
    } catch(e) {
      console.error('Error general al insertar cliente:', e);
    }
  }

  appState.customers.push({ id: newId, name, phone, code, notes });
  saveState();
  selectedCustomerId = newId;

  nameInput.value = '';
  phoneInput.value = '';
  codeInput.value = '';
  notesInput.value = '';

  closeModal('modalNewCustomer');

  if (supabaseClient) await fetchDataFromSupabase();
  renderVendedorView(document.getElementById('vendedorScreen'));
  
  alert(`¡Cliente "${name}" registrado correctamente! PIN asignado: ${code}`);
}

function openAddItemModal(customerId) {
  selectedCustomerId = customerId;
  openModal('modalAddItem');
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
  let newItemId = 'i_' + Date.now();

  if (supabaseClient) {
    try {
      let { data: account } = await supabaseClient.from('fiado_accounts').select('id').eq('customer_id', selectedCustomerId).maybeSingle();
      
      if (!account) {
        const { data: stores } = await supabaseClient.from('stores').select('id').limit(1);
        const storeId = stores && stores.length > 0 ? stores[0].id : null;
        if (storeId) {
          const { data: newAcc } = await supabaseClient.from('fiado_accounts').insert([{
            customer_id: selectedCustomerId,
            store_id: storeId
          }]).select('id');
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

        if (newItem && newItem.length > 0) newItemId = newItem[0].id;
        if (itemErr) console.error('Error guardando producto fiado en Supabase:', itemErr);
      }
    } catch(e) {
      console.error('Error insertando fiado:', e);
    }
  }

  appState.items.push({
    id: newItemId,
    customerId: selectedCustomerId,
    name, qty, unitPrice,
    date: today, verified: false
  });

  await sendChatMessage('sistema', `📦 Fiado anotado: ${qty}x ${name} (S/ ${(qty * unitPrice).toFixed(2)})`);

  saveState();
  nameInput.value = '';
  priceInput.value = '';

  closeModal('modalAddItem');
  if (supabaseClient) await fetchDataFromSupabase();
  renderVendedorView(document.getElementById('vendedorScreen'));
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

  const today = new Date().toISOString().split('T')[0];
  let newPayId = 'p_' + Date.now();

  if (supabaseClient) {
    try {
      let { data: account } = await supabaseClient.from('fiado_accounts').select('id').eq('customer_id', selectedCustomerId).maybeSingle();
      if (account) {
        const { data: newPay } = await supabaseClient.from('payments').insert([{
          account_id: account.id,
          amount: amount,
          payment_method: method
        }]).select('id');
        if (newPay && newPay.length > 0) newPayId = newPay[0].id;
      }
    } catch(e) {
      console.error('Error guardando pago en Supabase:', e);
    }
  }

  appState.payments.push({
    id: newPayId,
    customerId: selectedCustomerId,
    amount, date: today, method
  });

  await sendChatMessage('sistema', `💵 Abono registrado: S/ ${amount.toFixed(2)} vía ${method}`);

  saveState();
  amountInput.value = '';
  closeModal('modalPayment');
  if (supabaseClient) await fetchDataFromSupabase();
  renderVendedorView(document.getElementById('vendedorScreen'));
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
    item.verified = true;

    if (supabaseClient) {
      await supabaseClient.from('fiado_items').update({ verified_by_customer: true }).eq('id', itemId);
    }

    await sendChatMessage('sistema', `✓ El cliente corroboró la compra de: ${item.name}`);
    saveState();
    renderClienteView(document.getElementById('clienteScreen'));
  }
}

function openDiscrepancyModal() { openModal('modalDiscrepancy'); }

// ENVIAR REPORTAR DISCREPANCIA (CLIENTE)
async function submitDiscrepancy() {
  const input = document.getElementById('discComment');
  const text = input.value.trim();
  if (!text) {
    alert('Explica el detalle de la observación.');
    return;
  }

  if (supabaseClient) {
    const { data: stores } = await supabaseClient.from('stores').select('id').limit(1);
    const storeId = stores && stores.length > 0 ? stores[0].id : null;

    if (storeId) {
      await supabaseClient.from('discrepancies').insert([{
        customer_id: selectedCustomerId,
        comment: text,
        status: 'pendiente'
      }]);
    }
  }

  await sendChatMessage('cliente', `⚠️ Reporte de observación sobre la cuenta: "${text}"`);

  input.value = '';
  saveState();
  closeModal('modalDiscrepancy');
  renderClienteView(document.getElementById('clienteScreen'));
  alert('Reporte enviado al vendedor por el chat.');
}

// ELIMINAR ÍTEM — solo vendedores autenticados
async function deleteItem(itemId) {
  if (!currentUser || currentUser.role !== 'vendedor') {
    alert('Acción no permitida.');
    return;
  }
  if (confirm('¿Eliminar este ítem del historial fiado?')) {
    if (supabaseClient) {
      await supabaseClient.from('fiado_items').delete().eq('id', itemId);
    }
    appState.items = appState.items.filter(i => i.id !== itemId);
    saveState();
    renderVendedorView(document.getElementById('vendedorScreen'));
  }
}

// ENVIAR MENSAJE DE CHAT (SUPABASE & LOCAL)
async function sendChatMessage(overrideRole, customText) {
  const input = document.getElementById('chatInput');
  const text = customText || (input ? input.value.trim() : '');
  if (!text) return;

  const senderRole = overrideRole || (currentUser ? currentUser.role : 'vendedor');
  let newMsgId = 'm_' + Date.now();

  if (supabaseClient && selectedCustomerId) {
    try {
      const { data: stores } = await supabaseClient.from('stores').select('id').limit(1);
      const storeId = stores && stores.length > 0 ? stores[0].id : null;

      if (storeId) {
        const { data: newMsg } = await supabaseClient.from('chat_messages').insert([{
          customer_id: selectedCustomerId,
          store_id: storeId,
          sender_type: senderRole,
          message: text
        }]).select('id');
        if (newMsg && newMsg.length > 0) newMsgId = newMsg[0].id;
      }
    } catch(e) {
      console.error('Error insertando mensaje en Supabase:', e);
    }
  }

  appState.chat.push({
    id: newMsgId,
    customerId: selectedCustomerId,
    sender: senderRole,
    text: text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });

  if (input) input.value = '';
  saveState();

  if (currentUser && currentUser.role === 'vendedor') {
    renderVendedorView(document.getElementById('vendedorScreen'));
  } else {
    renderClienteView(document.getElementById('clienteScreen'));
  }
}

function scrollChatToBottom() {
  setTimeout(() => {
    const container = document.getElementById('chatContainer');
    if (container) container.scrollTop = container.scrollHeight;
  }, 100);
}

// RENDERIZADO VENDEDOR Y CLIENTE
function renderVendedorView(container) {
  const metrics = getStoreMetrics();
  const activeCustomer = appState.customers.find(c => c.id === selectedCustomerId) || appState.customers[0];
  if (activeCustomer) selectedCustomerId = activeCustomer.id;

  const activeCustomerBalance = activeCustomer ? getCustomerBalance(activeCustomer.id) : 0;
  const activeItems = activeCustomer ? appState.items.filter(i => i.customerId === selectedCustomerId) : [];
  const activeChat = activeCustomer ? appState.chat.filter(m => m.customerId === selectedCustomerId) : [];

  container.innerHTML = `
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
  const activeCustomer = appState.customers.find(c => c.id === selectedCustomerId) || appState.customers[0];
  if (activeCustomer) selectedCustomerId = activeCustomer.id;

  const balance = activeCustomer ? getCustomerBalance(activeCustomer.id) : 0;
  const activeItems = activeCustomer ? appState.items.filter(i => i.customerId === selectedCustomerId) : [];
  const activeChat = activeCustomer ? appState.chat.filter(m => m.customerId === selectedCustomerId) : [];

  container.innerHTML = `
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
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No tienes productos pendientes en tu cuenta. ¡Estás al día! 🎉</td></tr>
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
