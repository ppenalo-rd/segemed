BEGIN;

CREATE TABLE IF NOT EXISTS specialties (
    id SERIAL PRIMARY KEY,
    code VARCHAR(40) UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctor_specialties (
    doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    specialty_id INTEGER NOT NULL REFERENCES specialties(id),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (doctor_id, specialty_id)
);

INSERT INTO specialties (code, name, description)
VALUES
    ('medicina-general', 'Medicina General', 'Atención integral de salud y evaluación inicial.'),
    ('pediatria', 'Pediatría', 'Atención médica de niñas, niños y adolescentes.'),
    ('traumatologia', 'Traumatología', 'Evaluación y tratamiento del sistema musculoesquelético.'),
    ('cardiologia', 'Cardiología', 'Prevención, diagnóstico y tratamiento de enfermedades cardiovasculares.'),
    ('ginecologia', 'Ginecología', 'Atención de salud ginecológica y reproductiva.')
ON CONFLICT DO NOTHING;

WITH mapped_doctors AS (
    SELECT d.id AS doctor_id,
           CASE REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(d.main_specialty)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
           )
               WHEN 'medicina' THEN 'medicina-general'
               WHEN 'medicinageneral' THEN 'medicina-general'
               WHEN 'medicinaintegral' THEN 'medicina-general'
               WHEN 'pediatria' THEN 'pediatria'
               WHEN 'traumatologia' THEN 'traumatologia'
               WHEN 'traumatologiayortopedia' THEN 'traumatologia'
               WHEN 'ortopedia' THEN 'traumatologia'
               WHEN 'cardiologia' THEN 'cardiologia'
               WHEN 'ginecologia' THEN 'ginecologia'
               WHEN 'ginecologiayobstetricia' THEN 'ginecologia'
               WHEN 'obstetriciayginecologia' THEN 'ginecologia'
               ELSE NULL
           END AS specialty_code
    FROM doctors d
    WHERE NULLIF(BTRIM(d.main_specialty), '') IS NOT NULL
)
UPDATE doctor_specialties ds
SET is_primary = FALSE
FROM mapped_doctors md
WHERE ds.doctor_id = md.doctor_id
  AND md.specialty_code IS NOT NULL;

WITH mapped_doctors AS (
    SELECT d.id AS doctor_id,
           CASE REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(d.main_specialty)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
           )
               WHEN 'medicina' THEN 'medicina-general'
               WHEN 'medicinageneral' THEN 'medicina-general'
               WHEN 'medicinaintegral' THEN 'medicina-general'
               WHEN 'pediatria' THEN 'pediatria'
               WHEN 'traumatologia' THEN 'traumatologia'
               WHEN 'traumatologiayortopedia' THEN 'traumatologia'
               WHEN 'ortopedia' THEN 'traumatologia'
               WHEN 'cardiologia' THEN 'cardiologia'
               WHEN 'ginecologia' THEN 'ginecologia'
               WHEN 'ginecologiayobstetricia' THEN 'ginecologia'
               WHEN 'obstetriciayginecologia' THEN 'ginecologia'
               ELSE NULL
           END AS specialty_code
    FROM doctors d
    WHERE NULLIF(BTRIM(d.main_specialty), '') IS NOT NULL
)
INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary)
SELECT md.doctor_id, s.id, TRUE
FROM mapped_doctors md
JOIN specialties s ON s.code = md.specialty_code AND s.active = TRUE
WHERE md.specialty_code IS NOT NULL
ON CONFLICT (doctor_id, specialty_id)
DO UPDATE SET is_primary = TRUE;

CREATE INDEX IF NOT EXISTS doctor_specialties_primary_idx
    ON doctor_specialties (doctor_id, is_primary);

COMMIT;
