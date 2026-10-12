// db.js - Conexión oficial a PostgreSQL
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});
module.exports = pool;

// consultationController.js - Ejemplo de guardado de consulta SOAP con auditoría
const pool = require('./db');

async function createConsultation(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { patient_id, doctor_id, appointment_id, subjective, objective, assessment, plan } = req.body;

    // 1. Insertar núcleo de consulta
    const consultationRes = await client.query(
      `INSERT INTO medical_consultations (patient_id, doctor_id, appointment_id) VALUES ($1, $2, $3) RETURNING id`,
      [patient_id, doctor_id, appointment_id]
    );
    const consultationId = consultationRes.rows[0].id;

    // 2. Insertar sección Subjetiva
    await client.query(
      `INSERT INTO soap_subjective (consultation_id, chief_complaint, current_illness, relevant_background) VALUES ($1, $2, $3, $4)`,
      [consultationId, subjective.chief_complaint, subjective.current_illness, subjective.relevant_background]
    );

    // 3. Insertar sección Objetivo
    await client.query(
      `INSERT INTO soap_objective (consultation_id, blood_pressure, heart_rate, temperature, physical_examination) VALUES ($1, $2, $3, $4, $5)`,
      [consultationId, objective.blood_pressure, objective.heart_rate, objective.temperature, objective.physical_examination]
    );

    // 4. Insertar sección Análisis (Assessment con CIE)
    await client.query(
      `INSERT INTO soap_assessment (consultation_id, primary_cie_id, secondary_cie_1_id, secondary_cie_2_id) VALUES ($1, $2, $3, $4)`,
      [consultationId, assessment.primary_cie_id, assessment.secondary_cie_1_id, assessment.secondary_cie_2_id]
    );

    // 5. Insertar sección Plan
    await client.query(
      `INSERT INTO soap_plan (consultation_id, diagnostic_plan, therapeutic_plan, education_recommendations) VALUES ($1, $2, $3, $4)`,
      [consultationId, plan.diagnostic_plan, plan.therapeutic_plan, plan.education_recommendations]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, consultation_id: consultationId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
}
import React, { useState } from 'react';

export default function SoapAccordionForm() {
  const [activeTab, setActiveTab] = useState('subjective');

  return (
    <div className="soap-container max-w-4xl mx-auto p-4 bg-white shadow rounded-lg">
      <h2 className="text-xl font-bold mb-4">Historia Clínica - Metodología SOAP</h2>
      
      {/* Botones de Pestañas / Acordeón */}
      <div className="flex border-b mb-4">
        {['subjective', 'objective', 'assessment', 'plan'].tab?.map || ['subjective', 'objective', 'assessment', 'plan'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`py-2 px-4 font-semibold capitalize ${activeTab === tab ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
          >
            {tab === 'subjective' && 'S - Subjetivo'}
            {tab === 'objective' && 'O - Objetivo'}
            {tab === 'assessment' && 'A - Análisis (CIE)'}
            {tab === 'plan' && 'P - Plan y Receta'}
          </button>
        ))}
      </div>

      {/* Contenido de las Secciones */}
      <div className="tab-content p-2">
        {activeTab === 'subjective' && (
          <div>
            <h3 className="font-medium text-gray-700 mb-2">Subjetivo</h3>
            <textarea placeholder="Motivo de consulta y enfermedad actual..." className="w-full p-2 border rounded" rows="4" />
          </div>
        )}
        {activeTab === 'objective' && (
          <div>
            <h3 className="font-medium text-gray-700 mb-2">Objetivo (Signos Vitales y Examen)</h3>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <input type="text" placeholder="PA (Ej: 120/80)" className="p-2 border rounded" />
              <input type="text" placeholder="FC (lpm)" className="p-2 border rounded" />
              <input type="text" placeholder="Temp (°C)" className="p-2 border rounded" />
            </div>
            <textarea placeholder="Exploración física..." className="w-full p-2 border rounded" rows="3" />
          </div>
        )}
        {activeTab === 'assessment' && (
          <div>
            <h3 className="font-medium text-gray-700 mb-2">Análisis y Diagnósticos (CIE-10/11)</h3>
            <input type="text" placeholder="Buscar diagnóstico principal (Autocompletado CIE)..." className="w-full p-2 border rounded mb-2" />
            <input type="text" placeholder="Diagnóstico secundario 1..." className="w-full p-2 border rounded mb-2" />
            <input type="text" placeholder="Diagnóstico secundario 2..." className="w-full p-2 border rounded" />
          </div>
        )}
        {activeTab === 'plan' && (
          <div>
            <h3 className="font-medium text-gray-700 mb-2">Plan Terapéutico y Prescripción</h3>
            <textarea placeholder="Medicamentos, dosis, indicaciones..." className="w-full p-2 border rounded mb-2" rows="3" />
            <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">Previsualizar Receta PDF y Enviar</button>
          </div>
        )}
      </div>
    </div>
  );
}