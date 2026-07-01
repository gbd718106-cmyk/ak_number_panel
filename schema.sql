-- AK NUMBER PANEL Database Schema
-- Paste this script into your Supabase SQL Editor

-- 1. Create table for Admin Web Users
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create table for Telegram Bots
CREATE TABLE IF NOT EXISTS telegram_bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    support_username TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Create table for Telegram Bot Users
CREATE TABLE IF NOT EXISTS bot_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID REFERENCES telegram_bots(id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    last_platform TEXT,
    last_range TEXT,
    last_provider_code TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(bot_id, telegram_id)
);

-- 4. Create table for API Providers
CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    unique_code TEXT UNIQUE NOT NULL, -- 2-4 letters e.g. 'MK'
    base_url TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Create table for API Provider Accounts (For Rotation)
CREATE TABLE IF NOT EXISTS provider_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL, -- e.g. 'First One'
    api_key TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Create table for Allocated Numbers
CREATE TABLE IF NOT EXISTS allocated_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_user_id UUID REFERENCES bot_users(id) ON DELETE CASCADE,
    bot_id UUID REFERENCES telegram_bots(id) ON DELETE CASCADE,
    provider_account_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
    platform TEXT NOT NULL, -- e.g. 'WhatsApp'
    range TEXT NOT NULL, -- e.g. '88017XXX'
    number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', -- 'active', 'completed', 'expired'
    allocated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 7. Create table for Received OTPs
CREATE TABLE IF NOT EXISTS received_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    allocated_number_id UUID REFERENCES allocated_numbers(id) ON DELETE CASCADE,
    otp_code TEXT NOT NULL,
    raw_message TEXT NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 8. Create table for Service Settings
CREATE TABLE IF NOT EXISTS service_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT UNIQUE NOT NULL, -- e.g. 'WhatsApp'
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    disabled_providers JSONB DEFAULT '[]'::jsonb, -- Array of provider UUIDs
    disabled_ranges JSONB DEFAULT '[]'::jsonb -- Array of range prefixes
);

-- 9. Create table for Global System Settings
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Insert Default Settings
INSERT INTO system_settings (key, value)
VALUES ('admin_support_url', 'https://t.me/ak_admin')
ON CONFLICT (key) DO NOTHING;

-- 10. Create table for Web Auth Tokens (Telegram deep-link authentication for user panel)
CREATE TABLE IF NOT EXISTS web_auth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT UNIQUE NOT NULL,
    telegram_user_id BIGINT,
    bot_id UUID REFERENCES telegram_bots(id) ON DELETE CASCADE,
    used BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Insert Default Admin User
-- default password is 'admin123' (hash generated using bcryptjs with 10 salt rounds)
-- You must change this after logging in.
INSERT INTO admin_users (email, password_hash, role, is_active)
VALUES ('admin@aknumber.com', '$2a$10$4Y9Bi96kL5E0nKnt1MRd5e88vUaJszgei3.1pKJbENPG094Sbf3Rq', 'superadmin', true)
ON CONFLICT (email) DO NOTHING;
