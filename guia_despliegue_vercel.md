# Guía Paso a Paso: Desplegar en Vercel - "Hoy Fío Mañana No"

Esta guía te explica cómo subir tu proyecto a **Vercel** de forma rápida y gratuita, y cómo actualizar las URLs en **Supabase** y **Google Cloud** para que la autenticación funcione perfectamente en tu dominio de Vercel.

---

## 🚀 OPCIÓN A: Subir desde Vercel Dashboard (Recomendada)

1. Ingresa a [Vercel.com](https://vercel.com/) e inicia sesión (con tu cuenta de GitHub, GitLab o Email).
2. Haz clic en el botón **"Add New..."** > **"Project"**.
3. Si tienes tu código subido a un repositorio de **GitHub**:
   - Selecciona tu repositorio `hoyFioMananaNo` y haz clic en **Import**.
   - En *Framework Preset*, selecciona **Other** (o déjalo automático ya que es un sitio web estático optimizado con `vercel.json`).
   - Haz clic en **Deploy**.
4. ¡En menos de 30 segundos Vercel te entregará la URL pública de tu web! (ejemplo: `https://hoy-fio-manana-no.vercel.app`).

---

## 💻 OPCIÓN B: Subir desde la Terminal usando Vercel CLI

Si tienes Node.js instalado, puedes ejecutar en tu terminal:

```bash
# Entrar a la carpeta del proyecto
cd C:\Users\Equipo\Documents\hoyFioMañanaNo

# Subir a Vercel con la CLI
npx vercel
```

Sigue los pasos en pantalla (presiona Enter para confirmar) y obtendrás la URL pública inmediatamente.

---

## ⚙️ ÚLTIMO PASO OBLIGATORIO: Ajustar URLs en Supabase y Google

Una vez que tengas tu enlace de Vercel (ejemplo: `https://hoy-fio-manana-no.vercel.app`), actualiza las siguientes dos configuraciones:

### 1. Configurar URL en Supabase Console
1. Entra a tu proyecto en [Supabase Console](https://supabase.com/).
2. Ve a **Authentication** > **URL Configuration**.
3. En **Site URL**, coloca tu enlace de Vercel:
   `https://hoy-fio-manana-no.vercel.app`
4. En **Redirect URLs**, agrega también tu enlace de Vercel:
   `https://hoy-fio-manana-no.vercel.app`
5. Guarda los cambios.

### 2. Configurar Orígenes en Google Cloud Console
1. Entra a [Google Cloud Console](https://console.cloud.google.com/) > **APIs y Servicios** > **Credenciales**.
2. Edita tu **ID de cliente de OAuth**.
3. En **Orígenes de JavaScript autorizados**, añade la URL de Vercel:
   `https://hoy-fio-manana-no.vercel.app`
4. Guarda los cambios.

---

¡Listo! Tu aplicación estará desplegada en Vercel, funcionará en celular como PWA instalable y los usuarios podrán autenticarse con Google y registrar sus fiados en tiempo real.
