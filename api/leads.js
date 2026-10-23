module.exports = (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      console.log('New Aslan Balaev Lead received on Vercel:', body);
      return res.status(200).json({
        status: 'ok',
        message: 'Заявка успешно принята',
        lead: body
      });
    } catch (e) {
      return res.status(200).json({
        status: 'ok',
        message: 'Заявка принята'
      });
    }
  }

  return res.status(200).json({
    status: 'ok',
    service: 'Aslan Balaev CRM API'
  });
};
