-- 063: fixed search paths on four small helper functions from 059 to 062 (security advisor).
alter function public.role_presets() set search_path = pg_catalog;
alter function private.perm_areas() set search_path = pg_catalog;
alter function private.feet_between(double precision, double precision, double precision, double precision) set search_path = pg_catalog;
alter function private.touch() set search_path = pg_catalog;
