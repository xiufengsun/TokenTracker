-- Validate historical tokens without retaining the ADD COLUMN exclusive lock.
SET LOCAL lock_timeout = '3s';
-- Keep the platform's enforced statement timeout.
ALTER TABLE public.tokentracker_device_tokens
  VALIDATE CONSTRAINT tokentracker_device_tokens_cloud_environment_fkey;
