-- 管理画面の利用者一覧で、Googleログインしたメールアドレスと日時を確認するための列を追加する。
-- 既存行のemailとlast_login_atはNULLのままとし、過去の利用者は復元しない。
ALTER TABLE public_users ADD COLUMN email TEXT;
ALTER TABLE public_users ADD COLUMN last_login_at TEXT;
