(function exposeCie10Autocomplete(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SIGEMEDCie10Autocomplete = api;
  }
}(globalThis, () => {
  function canonicalizeCie10Selection(diagnosis) {
    if (!diagnosis
        || !Number.isSafeInteger(Number(diagnosis.id))
        || Number(diagnosis.id) < 1
        || typeof diagnosis.code !== 'string'
        || !/^[a-z0-9.]+$/i.test(diagnosis.code)
        || typeof diagnosis.description !== 'string'
        || !diagnosis.description.trim()) {
      return null;
    }
    return {
      id: Number(diagnosis.id),
      code: diagnosis.code.toUpperCase(),
      description: diagnosis.description,
    };
  }

  function formatCie10Diagnosis(diagnosis) {
    if (!diagnosis || typeof diagnosis.code !== 'string'
        || !/^[a-z0-9.]+$/i.test(diagnosis.code)
        || typeof diagnosis.description !== 'string'
        || !diagnosis.description.trim()) return '';
    return `${diagnosis.code.toUpperCase()} - ${diagnosis.description.trim()}`;
  }

  function isCurrentSearchResponse(requestId, currentRequestId, requestedQuery, currentQuery) {
    return requestId === currentRequestId && requestedQuery === currentQuery;
  }

  return { canonicalizeCie10Selection, formatCie10Diagnosis, isCurrentSearchResponse };
}));
