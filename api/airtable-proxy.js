/**
 * Proxy Airtable (fonction serverless Vercel).
 *
 * Reçoit les requêtes de l'outil (navigateur), les relaie vers l'API Airtable
 * en ajoutant le token côté serveur, renvoie la réponse telle quelle.
 * Le navigateur ne voit jamais le token — il vit uniquement dans les
 * variables d'environnement Vercel (jamais dans ce fichier, jamais dans Git).
 *
 * Appels attendus depuis l'outil, par exemple :
 *   GET    /api/airtable-proxy?table=eleves
 *   GET    /api/airtable-proxy?table=eleves&id=recXXXXXXXXXXXXXX
 *   POST   /api/airtable-proxy?table=reservations   (corps JSON)
 *   PATCH  /api/airtable-proxy?table=reservations&id=recXXXXXXXXXXXXXX
 *   DELETE /api/airtable-proxy?table=reservations&id=recXXXXXXXXXXXXXX
 */

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Le navigateur envoie une requête "OPTIONS" de vérification avant certains appels.
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const TABLES = {
    creneaux: process.env.TABLE_CRENEAUX,
    eleves: process.env.TABLE_ELEVES,
    reservations: process.env.TABLE_RESERVATIONS,
  };

  const { table, id, ...queryParams } = req.query;

  if (!table || !TABLES[table]) {
    res.status(400).json({ error: 'Paramètre "table" manquant ou inconnu.' });
    return;
  }

  const baseUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLES[table]}`;
  let url = id ? `${baseUrl}/${id}` : baseUrl;

  // Pour un GET, on relaie tels quels les éventuels paramètres Airtable
  // (filterByFormula, pageSize, sort[0][field], etc.) fournis par l'outil.
  if (req.method === 'GET' && Object.keys(queryParams).length > 0) {
    const search = new URLSearchParams(queryParams).toString();
    url += `?${search}`;
  }

  try {
    const airtableRes = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    const data = await airtableRes.text();
    res.status(airtableRes.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    res.status(502).json({ error: 'Impossible de joindre Airtable.', detail: String(err) });
  }
};
