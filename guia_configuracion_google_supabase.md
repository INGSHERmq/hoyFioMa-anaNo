# Guía Completa: Autenticación con Google en Supabase para "Hoy Fío Mañana No"

Esta guía te explica paso a paso cómo configurar el inicio de sesión con Google (Google OAuth 2.0) en **Supabase** y cómo conectar tu aplicación web para manejar la asignación de roles (**Vendedor** o **Cliente**).

---

## 📌 Paso 1: Configurar el Proyecto en Google Cloud Console

1. Inicia sesión en [Google Cloud Console](https://console.cloud.google.com/).
2. En la barra superior, haz clic en el selector de proyectos y presiona **"Nuevo Proyecto"**.
3. Nombra tu proyecto (ej: `Hoy Fío Mañana No`) y haz clic en **Crear**.

---

## 📌 Paso 2: Configurar la Pantalla de Consentimiento OAuth

1. En el menú lateral izquierdo, ve a **APIs y Servicios** > **Pantalla de consentimiento de OAuth** (*OAuth consent screen*).
2. Selecciona el tipo de usuario **External** (Externo) y haz clic en **Crear**.
3. Completa la información requerida:
   - **Nombre de la app**: `Hoy Fío Mañana No`
   - **Correo de soporte del usuario**: Tu correo electrónico.
   - **Datos de contacto del desarrollador**: Tu correo electrónico.
4. Presiona **Guardar y Continuar**.
5. En la sección **Permisos / Scopes**, presiona **Agregar o Quitar Permisos** y selecciona:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`
6. Guarda y avanza hasta finalizar la configuración.

---

## 📌 Paso 3: Obtener la URL de Callback de Supabase

1. Abre tu proyecto en el panel de [Supabase](https://supabase.com/dashboard).
2. Ve al menú lateral izquierdo: **Authentication** > **Providers**.
3. Busca **Google** en la lista y despliega su configuración.
4. Copia la **Redirect URL (Callback URL)** que te proporciona Supabase. Tiene un formato similar a:
   `https://<tu-id-de-proyecto>.supabase.co/auth/v1/callback`

---

## 📌 Paso 4: Crear Credenciales de Cliente OAuth en Google

1. Regresa a **Google Cloud Console**.
2. Ve a **APIs y Servicios** > **Credenciales**.
3. Haz clic en **+ Crear Credenciales** > **ID de cliente de OAuth** (*OAuth client ID*).
4. Selecciona **Tipo de aplicación**: `Aplicación web` (*Web application*).
5. Configura los siguientes campos:
   - **Orígenes de JavaScript autorizados**:
     - `http://localhost:5500` (o la URL de tu servidor local)
     - `https://tu-dominio.com` (cuando lo despliegues)
   - **URIs de redireccionamiento autorizados**:
     - Pega aquí la **Redirect URL (Callback URL)** que copiaste de Supabase en el Paso 3.
6. Haz clic en **Crear**.
7. Se abrirá una ventana que te mostrará:
   - **ID de cliente** (*Client ID*)
   - **Secreto de cliente** (*Client Secret*)

---

## 📌 Paso 5: Guardar Credenciales en Supabase

1. Regresa a tu panel de **Supabase** > **Authentication** > **Providers** > **Google**.
2. Activa la casilla **Enable Google provider**.
3. Pega el **Client ID** y el **Client Secret** generados en Google.
4. Presiona **Save** (Guardar).

---

## 📌 Paso 6: Integración del Código JavaScript Frontend

En tu archivo [app.js](file:///C:/Users/Equipo/Documents/hoyFioMa%C3%B1anaNo/app.js), puedes inicializar el cliente de Supabase y llamar a la función de Google:

```javascript
// Importar o cargar Supabase JS SDK
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://<tu-proyecto>.supabase.co';
const supabaseAnonKey = 'tu-anon-key-de-supabase';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Función para Iniciar Sesión con Google
async function loginWithGoogleSupabase() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin // Redirige de vuelta a tu web tras autenticar
    }
  });

  if (error) {
    console.error('Error al autenticar con Google:', error.message);
  }
}
```

---

## 📌 Paso 7: Manejo del Rol tras Iniciar Sesión con Google

Cuando el usuario inicia sesión con Google por primera vez, se ejecuta automáticamente el trigger SQL de nuestra base de datos `supabase_schema.sql`, creando su perfil en la tabla `profiles`.

Para asignarle su rol (**Vendedor** o **Cliente**):

1. En el frontend, detecta si el usuario recién autenticado no tiene un rol definido en su perfil.
2. Si no tiene rol, abre el modal de selección de rol (**¿Eres Vendedor o Cliente?**) que construimos en la web.
3. Actualiza su tabla `profiles` en Supabase:

```javascript
async function setGoogleUserRole(userId, selectedRole) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ role: selectedRole })
    .eq('id', userId);

  if (!error) {
    // Redirigir a la vista correspondiente
    window.location.reload();
  }
}
```

---

¡Listo! Con estos pasos, cualquier usuario podrá registrarse e ingresar tanto con su cuenta tradicional como con **Google OAuth**, seleccionando su rol y accediendo a la vista correspondiente.
