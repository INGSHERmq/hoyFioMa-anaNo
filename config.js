/* ==========================================================================
   CONFIGURACIÓN DE SUPABASE - "HOY FÍO MAÑANA NO"
   ==========================================================================
   
   ✅ SEGURIDAD:
   - La "anonKey" es una clave PÚBLICA por diseño (prefijo sb_publishable_).
     Es seguro que esté aquí en el frontend.
   - La seguridad real de los datos la maneja Supabase mediante
     Row Level Security (RLS) en la base de datos.
   - NUNCA coloques aquí la "service_role" key de Supabase.
   
   ℹ️  Para cambiar el proyecto de Supabase, edita los valores de abajo.
*/

const SUPABASE_CONFIG = {
  // URL pública de tu proyecto en Supabase
  url: 'https://idlppqevdbjplnibokvt.supabase.co',
  
  // Clave anónima/pública de Supabase (safe to expose in frontend)
  anonKey: 'sb_publishable_M-rIP3icN_H3TmGEcG_kmg_jT_gZ5cd'
};
