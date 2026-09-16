-- ==============================================================================
-- SCRIPT DE BASE DE DATOS PARA SUPABASE - "HOY FÍO MAÑANA NO" (ENTORNO LIMPIO DE PRODUCCIÓN)
-- Copia y pega este script en el SQL Editor de tu consola Supabase.
-- Compatible con Autenticación por Correo/Contraseña y OAuth de Google.
-- ==============================================================================

-- 1. EXTENSIONES REQUERIDAS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. ELIMINACIÓN PREVIA PARA RESTRUCTURACIÓN LIMPIA
DROP TABLE IF EXISTS discrepancies CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS fiado_items CASCADE;
DROP TABLE IF EXISTS fiado_accounts CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS stores CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

-- 3. TABLA DE PERFILES DE USUARIO (Vinculada a auth.users de Supabase)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(150),
    role VARCHAR(20) NOT NULL CHECK (role IN ('vendedor', 'cliente')),
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. TABLA DE TIENDAS / VENDEDORES
CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    store_name VARCHAR(100) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(150),
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. TABLA DE CLIENTES
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    access_code VARCHAR(10) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_customer_code_per_store UNIQUE(store_id, access_code)
);

-- 6. TABLA DE CUENTAS DE FIADO
CREATE TABLE fiado_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    total_balance DECIMAL(10, 2) DEFAULT 0.00 CHECK (total_balance >= 0),
    status VARCHAR(20) DEFAULT 'al_dia' CHECK (status IN ('al_dia', 'pendiente', 'en_reclamo', 'mora')),
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_customer_account UNIQUE(customer_id)
);

-- 7. TABLA DE ÍTEMS FIADOS
CREATE TABLE fiado_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES fiado_accounts(id) ON DELETE CASCADE,
    product_name VARCHAR(150) NOT NULL,
    quantity DECIMAL(8, 2) NOT NULL DEFAULT 1.00 CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
    total_price DECIMAL(10, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    item_date DATE DEFAULT CURRENT_DATE,
    verified_by_customer BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. TABLA DE PAGOS / ABONOS
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES fiado_accounts(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(50) DEFAULT 'efectivo',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. TABLA DE CHAT / MENSAJES
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('vendedor', 'cliente', 'sistema')),
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. TABLA DE DISCREPANCIAS
CREATE TABLE discrepancies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id UUID NOT NULL REFERENCES fiado_items(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    reported_price DECIMAL(10, 2),
    comment TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelto', 'rechazado')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. TRIGGER PARA CREACIÓN AUTOMÁTICA DE PERFIL TRAS REGISTRO SUPABASE AUTH
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
        COALESCE(NEW.raw_user_meta_data->>'role', 'cliente'),
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 12. TRIGGER RECALCULADOR DE SALDOS
CREATE OR REPLACE FUNCTION recalculate_fiado_balance()
RETURNS TRIGGER AS $$
DECLARE
    target_account_id UUID;
    sum_items DECIMAL(10, 2);
    sum_payments DECIMAL(10, 2);
    new_balance DECIMAL(10, 2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_account_id := OLD.account_id;
    ELSE
        target_account_id := NEW.account_id;
    END IF;

    SELECT COALESCE(SUM(total_price), 0.00) INTO sum_items
    FROM fiado_items WHERE account_id = target_account_id;

    SELECT COALESCE(SUM(amount), 0.00) INTO sum_payments
    FROM payments WHERE account_id = target_account_id;

    new_balance := sum_items - sum_payments;
    IF new_balance < 0 THEN new_balance := 0.00; END IF;

    UPDATE fiado_accounts
    SET total_balance = new_balance,
        status = CASE WHEN new_balance = 0 THEN 'al_dia' ELSE 'pendiente' END,
        last_activity = CURRENT_TIMESTAMP
    WHERE id = target_account_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_balance_items
AFTER INSERT OR UPDATE OR DELETE ON fiado_items
FOR EACH ROW EXECUTE FUNCTION recalculate_fiado_balance();

CREATE TRIGGER trg_update_balance_payments
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION recalculate_fiado_balance();

-- 13. POLÍTICAS RLS DE SEGURIDAD
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiado_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiado_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE discrepancies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Perfiles accesibles por su dueño" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "Tiendas accesibles para vendedores" ON stores FOR ALL USING (true);
CREATE POLICY "Clientes accesibles en tienda" ON customers FOR ALL USING (true);
CREATE POLICY "Cuentas fiado accesibles" ON fiado_accounts FOR ALL USING (true);
CREATE POLICY "Items fiados accesibles" ON fiado_items FOR ALL USING (true);
CREATE POLICY "Pagos accesibles" ON payments FOR ALL USING (true);
CREATE POLICY "Chat accesible" ON chat_messages FOR ALL USING (true);
CREATE POLICY "Discrepancias accesibles" ON discrepancies FOR ALL USING (true);

-- ESQUEMA LIMPIO LISTO PARA USO EN PRODUCCIÓN (SIN REGISTROS DE PRUEBA)
