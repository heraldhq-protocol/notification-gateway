-- CreateEnum: AdminUserRole
CREATE TYPE "AdminUserRole" AS ENUM ('super_admin', 'admin', 'viewer');

-- CreateEnum: AdminAuthMethod
CREATE TYPE "AdminAuthMethod" AS ENUM ('wallet', 'email-totp');

-- Migrate existing data before altering column
UPDATE "admin_users" SET role = 'viewer' WHERE role NOT IN ('super_admin', 'admin', 'viewer');

-- AlterTable: admin_users.role → AdminUserRole enum
ALTER TABLE "admin_users"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" TYPE "AdminUserRole" USING role::"AdminUserRole",
  ALTER COLUMN "role" SET DEFAULT 'viewer';

-- AlterTable: admin_users.auth_method → AdminAuthMethod enum
ALTER TABLE "admin_users"
  ALTER COLUMN "auth_method" TYPE "AdminAuthMethod" USING "auth_method"::"AdminAuthMethod";
