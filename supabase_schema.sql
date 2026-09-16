-- ==============================================================================
-- SCRIPT DE BASE DE DATOS SEGURO PARA SUPABASE - "HOY FÍO MAÑANA NO"
-- VERSIÓN DE PRODUCCIÓN CON RLS REAL (Row Level Security)
-- ==============================================================================
-- ⚠️  IMPORTANTE: Si ya tienes datos, NO ejecutes las líneas DROP TABLE.
--     En ese caso, solo ejecuta desde la sección "DROP POLICY" en adelante.
-- ==============================================================================

-- 1. EXTENSIONES REQUERIDAS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. ELIMINACIÓN PREVIA PARA RESTRUCTURACIÓN LIMPIA
--    (Comentar estas líneas si ya tienes datos en producción)
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
    -- El rol SOLO puede ser asignado por la app (nunca por el usuario directamente)
    role VARCHAR(20) NOT NULL DEFAULT 'cliente' CHECK (role IN ('vendedor', 'cliente')),
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. TABLA DE TIENDAS / VENDEDORES
CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
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

-- 7. TABLA DE ITEMS FIADOS
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
    item_id UUID REFERENCES fiado_items(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    reported_price DECIMAL(10, 2),
    comment TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelto', 'rechazado')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 11. TRIGGER: CREACION AUTOMATICA DE PERFIL TRAS REGISTRO
-- ==============================================================================
-- SEGURO: El role SIEMPRE se asigna como 'cliente' por defecto.
-- Un administrador debe promover manualmente a 'vendedor' via SQL.
-- Esto evita que un usuario se registre como 'vendedor' manipulando el formulario.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        'cliente',
        NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ==============================================================================
-- 12. FUNCION PARA PROMOVER UN USUARIO A VENDEDOR (solo ejecutar manualmente)
-- ==============================================================================
-- Para hacer que un usuario sea vendedor, ejecuta en el SQL Editor de Supabase:
--   SELECT promote_to_vendedor('email-del-usuario@ejemplo.com');
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.promote_to_vendedor(p_email TEXT)
RETURNS TEXT AS $$
DECLARE
    affected INT;
BEGIN
    UPDATE public.profiles SET role = 'vendedor'
    WHERE email = lower(p_email);
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected = 0 THEN
        RETURN 'No se encontro ningun usuario con ese email.';
    END IF;
    RETURN 'Usuario ' || p_email || ' promovido a vendedor correctamente.';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==============================================================================
-- 13. TRIGGER: RECALCULADOR DE SALDOS
-- ==============================================================================
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

DROP TRIGGER IF EXISTS trg_update_balance_items ON fiado_items;
CREATE TRIGGER trg_update_balance_items
AFTER INSERT OR UPDATE OR DELETE ON fiado_items
FOR EACH ROW EXECUTE FUNCTION recalculate_fiado_balance();

DROP TRIGGER IF EXISTS trg_update_balance_payments ON payments;
CREATE TRIGGER trg_update_balance_payments
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION recalculate_fiado_balance();

-- ==============================================================================
-- 14. ACTIVAR RLS EN TODAS LAS TABLAS
-- ==============================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiado_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiado_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE discrepancies ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 15. FUNCION AUXILIAR: Obtener el role del usuario autenticado desde profiles
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ==============================================================================
-- 16. POLITICAS RLS: PROFILES
-- ==============================================================================
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;

CREATE POLICY "profiles_select_own" ON profiles
    FOR SELECT USING (auth.uid() = id);

-- El usuario puede actualizar su perfil pero NO puede cambiar su propio role
CREATE POLICY "profiles_update_own" ON profiles
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (
        auth.uid() = id
        AND role = (SELECT role FROM profiles WHERE id = auth.uid())
    );

-- ==============================================================================
-- 17. POLITICAS RLS: STORES
-- ==============================================================================
DROP POLICY IF EXISTS "stores_vendedor_crud"  ON stores;
DROP POLICY IF EXISTS "stores_cliente_select" ON stores;

-- Vendedor: CRUD solo en su propia tienda
CREATE POLICY "stores_vendedor_crud" ON stores
    FOR ALL USING (
        owner_id = auth.uid()
        AND public.get_my_role() = 'vendedor'
    )
    WITH CHECK (
        owner_id = auth.uid()
        AND public.get_my_role() = 'vendedor'
    );

-- Cliente: solo puede leer la tienda a la que pertenece
CREATE POLICY "stores_cliente_select" ON stores
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND id IN (SELECT store_id FROM customers WHERE user_id = auth.uid())
    );

-- ==============================================================================
-- 18. POLITICAS RLS: CUSTOMERS
-- ==============================================================================
DROP POLICY IF EXISTS "customers_vendedor_crud"   ON customers;
DROP POLICY IF EXISTS "customers_cliente_select"  ON customers;
DROP POLICY IF EXISTS "customers_anon_pin_lookup" ON customers;

-- Vendedor: CRUD en clientes de su tienda
CREATE POLICY "customers_vendedor_crud" ON customers
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
    )
    WITH CHECK (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
    );

-- Cliente autenticado: solo puede ver su propio registro
CREATE POLICY "customers_cliente_select" ON customers
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND user_id = auth.uid()
    );

-- Usuario anonimo: puede buscar por PIN para el login inicial
-- (acceso restringido, necesario para el flujo de vinculacion por PIN)
CREATE POLICY "customers_anon_pin_lookup" ON customers
    FOR SELECT USING (auth.role() = 'anon');

-- ==============================================================================
-- 19. POLITICAS RLS: FIADO_ACCOUNTS
-- ==============================================================================
DROP POLICY IF EXISTS "accounts_vendedor_crud"  ON fiado_accounts;
DROP POLICY IF EXISTS "accounts_cliente_select" ON fiado_accounts;

-- Vendedor: accede solo a cuentas de su tienda
CREATE POLICY "accounts_vendedor_crud" ON fiado_accounts
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
    )
    WITH CHECK (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
    );

-- Cliente: solo puede leer su propia cuenta
CREATE POLICY "accounts_cliente_select" ON fiado_accounts
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
    );

-- ==============================================================================
-- 20. POLITICAS RLS: FIADO_ITEMS
-- ==============================================================================
DROP POLICY IF EXISTS "items_vendedor_crud"         ON fiado_items;
DROP POLICY IF EXISTS "items_cliente_select_verify" ON fiado_items;
DROP POLICY IF EXISTS "items_cliente_update_verify" ON fiado_items;

-- Vendedor: CRUD en items de sus cuentas
CREATE POLICY "items_vendedor_crud" ON fiado_items
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN stores s ON fa.store_id = s.id
            WHERE s.owner_id = auth.uid()
        )
    )
    WITH CHECK (
        public.get_my_role() = 'vendedor'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN stores s ON fa.store_id = s.id
            WHERE s.owner_id = auth.uid()
        )
    );

-- Cliente: puede leer sus items
CREATE POLICY "items_cliente_select_verify" ON fiado_items
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN customers c ON fa.customer_id = c.id
            WHERE c.user_id = auth.uid()
        )
    );

-- Cliente: SOLO puede cambiar verified_by_customer = true (corroborar)
CREATE POLICY "items_cliente_update_verify" ON fiado_items
    FOR UPDATE USING (
        public.get_my_role() = 'cliente'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN customers c ON fa.customer_id = c.id
            WHERE c.user_id = auth.uid()
        )
        AND verified_by_customer = FALSE
    )
    WITH CHECK (verified_by_customer = TRUE);

-- ==============================================================================
-- 21. POLITICAS RLS: PAYMENTS
-- ==============================================================================
DROP POLICY IF EXISTS "payments_vendedor_crud"  ON payments;
DROP POLICY IF EXISTS "payments_cliente_select" ON payments;

-- Vendedor: CRUD en pagos de su tienda
CREATE POLICY "payments_vendedor_crud" ON payments
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN stores s ON fa.store_id = s.id
            WHERE s.owner_id = auth.uid()
        )
    )
    WITH CHECK (
        public.get_my_role() = 'vendedor'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN stores s ON fa.store_id = s.id
            WHERE s.owner_id = auth.uid()
        )
    );

-- Cliente: solo puede ver sus propios pagos
CREATE POLICY "payments_cliente_select" ON payments
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND account_id IN (
            SELECT fa.id FROM fiado_accounts fa
            JOIN customers c ON fa.customer_id = c.id
            WHERE c.user_id = auth.uid()
        )
    );

-- ==============================================================================
-- 22. POLITICAS RLS: CHAT_MESSAGES
-- ==============================================================================
DROP POLICY IF EXISTS "chat_vendedor_crud"   ON chat_messages;
DROP POLICY IF EXISTS "chat_cliente_select"  ON chat_messages;
DROP POLICY IF EXISTS "chat_cliente_insert"  ON chat_messages;

-- Vendedor: CRUD en chats de su tienda, solo puede enviar como 'vendedor'
CREATE POLICY "chat_vendedor_crud" ON chat_messages
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
    )
    WITH CHECK (
        public.get_my_role() = 'vendedor'
        AND store_id IN (SELECT id FROM stores WHERE owner_id = auth.uid())
        AND sender_type = 'vendedor'
    );

-- Cliente: puede leer su chat
CREATE POLICY "chat_cliente_select" ON chat_messages
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
    );

-- Cliente: puede insertar mensajes, solo como 'cliente'
CREATE POLICY "chat_cliente_insert" ON chat_messages
    FOR INSERT WITH CHECK (
        public.get_my_role() = 'cliente'
        AND customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
        AND sender_type = 'cliente'
    );

-- ==============================================================================
-- 23. POLITICAS RLS: DISCREPANCIAS
-- ==============================================================================
DROP POLICY IF EXISTS "disc_vendedor_manage" ON discrepancies;
DROP POLICY IF EXISTS "disc_cliente_insert"  ON discrepancies;
DROP POLICY IF EXISTS "disc_cliente_select"  ON discrepancies;

-- Vendedor: gestiona discrepancias de su tienda
CREATE POLICY "disc_vendedor_manage" ON discrepancies
    FOR ALL USING (
        public.get_my_role() = 'vendedor'
        AND customer_id IN (
            SELECT c.id FROM customers c
            JOIN stores s ON c.store_id = s.id
            WHERE s.owner_id = auth.uid()
        )
    );

-- Cliente: puede reportar una discrepancia sobre su cuenta
CREATE POLICY "disc_cliente_insert" ON discrepancies
    FOR INSERT WITH CHECK (
        public.get_my_role() = 'cliente'
        AND customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
    );

-- Cliente: puede ver sus propias discrepancias
CREATE POLICY "disc_cliente_select" ON discrepancies
    FOR SELECT USING (
        public.get_my_role() = 'cliente'
        AND customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
    );

-- ==============================================================================
-- FIN DEL SCRIPT - BASE DE DATOS LISTA PARA PRODUCCION SEGURA
-- ==============================================================================
-- Para promover un usuario a vendedor, ejecuta en el SQL Editor de Supabase:
--   SELECT promote_to_vendedor('email@ejemplo.com');
-- ==============================================================================
