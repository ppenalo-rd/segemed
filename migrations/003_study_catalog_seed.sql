BEGIN;

INSERT INTO study_catalog (code, name, category, description)
VALUES
    ('SIG-LAB-HEMOGRAMA', 'Hemograma completo', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-GLUCOSA', 'Glucosa en sangre', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-CREATININA', 'Creatinina sérica', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-UREA', 'Urea sérica', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-PERFIL-LIPIDICO', 'Perfil lipídico', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-ORINA', 'Examen general de orina', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-COPRO', 'Examen coproparasitario', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-TSH', 'TSH', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-LAB-HEMOGLOBINA-GLICOSILADA', 'Hemoglobina glicosilada (HbA1c)', 'Laboratorio', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.'),
    ('SIG-IMG-RX-TORAX', 'Radiografía de tórax', 'Imágenes', 'Catálogo inicial SIGEMED; especificar proyecciones e indicación clínica en la orden.'),
    ('SIG-IMG-ECO-ABDOMINAL', 'Ecografía abdominal', 'Imágenes', 'Catálogo inicial SIGEMED; especificar región e indicación clínica en la orden.'),
    ('SIG-CARD-ECG-12', 'Electrocardiograma de 12 derivaciones', 'Cardiología', 'Catálogo inicial SIGEMED; configurar el protocolo local antes de su uso clínico.')
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS study_orders_one_active_study_per_consultation_idx
    ON study_orders (consultation_id, study_id)
    WHERE status IN ('ordered', 'scheduled', 'in_progress');

COMMIT;
