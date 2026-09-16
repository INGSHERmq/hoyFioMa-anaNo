/* ==========================================================================
   CONFIGURACIÓN DE SUPABASE - "HOY FÍO MAÑANA NO"
   ========================================================================== 
   Puedes colocar directamente tu URL y tu Anon Key de Supabase aquí o 
   ingresarlas desde la interfaz de la web usando el botón "⚙️ Conectar Supabase".
*/

const SUPABASE_CONFIG = {
  // Reemplaza con la URL de tu proyecto en Supabase (ej: 'https://xyzcompany.supabase.co')
  url: localStorage.getItem('supabase_url') || 'https://idlppqevdbjplnibokvt.supabase.co',
  
  // Reemplaza con la clave anónima pública de tu proyecto en Supabase (ej: 'eyJhbGciOi...')
  anonKey: localStorage.getItem('supabase_key') || 'sb_publishable_M-rIP3icN_H3TmGEcG_kmg_jT_gZ5cd'
};

// Función helper para guardar la configuración desde la web
function saveSupabaseCredentials(url, key) {
  localStorage.setItem('supabase_url', url.trim());
  localStorage.setItem('supabase_key', key.trim());
  window.location.reload();
}
