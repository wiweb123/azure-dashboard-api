require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*"
}));

const PORT = process.env.PORT || 3000;

// 🔐 Azure config
const ORG = process.env.AZURE_ORG;
const PROJECT = process.env.AZURE_PROJECT;
const PAT = process.env.AZURE_PAT;

const auth = Buffer.from(`:${PAT}`).toString('base64');


// ===============================
// 🧠 CACHE GLOBAL
// ===============================
let cache = {
  dashboard: null,
  lastSync: null,
  loading: false
};


// ===============================
// 🧠 SYNC PRINCIPAL
// ===============================
async function syncDashboard() {
  if (cache.loading) return;

  try {
    cache.loading = true;

    console.log("🔄 Sync Azure iniciado...");

    const query = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE 
          [System.TeamProject] = '${PROJECT}'
          AND [System.ChangedDate] >= @StartOfDay('-30')
        ORDER BY [System.ChangedDate] DESC
      `
    };

    const wiqlResponse = await axios.post(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/wiql?api-version=7.0`,
      query,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const ids = wiqlResponse.data.workItems.map(w => w.id);

    if (ids.length === 0) {
      cache.dashboard = { kpis: {}, kanban: {}, users: [] };
      return;
    }

    const chunkSize = 50;
    let allItems = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);

      const resp = await axios.get(
        `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      allItems = allItems.concat(resp.data.value);
    }

    // ===============================
    // KPIs
    // ===============================
    const total = allItems.length;
    const done = allItems.filter(i => i.fields["System.State"] === "Done").length;
    const active = allItems.filter(i => i.fields["System.State"] === "Active").length;
    const blocked = allItems.filter(i => i.fields["System.State"] === "Blocked").length;

    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    // ===============================
    // KANBAN
    // ===============================
    const kanban = {
      "Fila Seller": [],
      "Fila Analista": [],
      "Em Andamento": [],
      "Em Impedimento": [],
      "Concluído": []
    };

    const users = {};

    allItems.forEach(item => {
      const fields = item.fields;

      const status = fields["System.State"];
      const title = fields["System.Title"];

      const user = fields["System.AssignedTo"]
        ? fields["System.AssignedTo"].displayName || fields["System.AssignedTo"].uniqueName
        : "Sem responsável";

      const card = {
        id: item.id,
        titulo: title,
        responsavel: user
      };

      if (status === "New") kanban["Fila Seller"].push(card);
      else if (status === "Approved" || status === "Ready") kanban["Fila Analista"].push(card);
      else if (status === "Active") kanban["Em Andamento"].push(card);
      else if (status === "Blocked") kanban["Em Impedimento"].push(card);
      else kanban["Concluído"].push(card);

      if (!users[user]) {
        users[user] = { nome: user, total: 0, done: 0 };
      }

      users[user].total += 1;
      if (status === "Done") users[user].done += 1;
    });

    const usersArray = Object.values(users).map(u => ({
      ...u,
      taxaConclusao: u.total > 0 ? Math.round((u.done / u.total) * 100) : 0
    }));

    cache.dashboard = {
      kpis: { total, done, active, blocked, progress },
      kanban,
      users: usersArray
    };

    cache.lastSync = new Date();

    console.log("✅ Sync concluído");

  } catch (err) {
    console.error("❌ Sync error:", err.message);
  } finally {
    cache.loading = false;
  }
}


// ===============================
// 🟢 HEALTH
// ===============================
app.get('/', (req, res) => {
  res.send('API funcionando 🚀');
});


// ===============================
// 📊 DASHBOARD
// ===============================
app.get('/dashboard', async (req, res) => {
  if (!cache.dashboard) {
    await syncDashboard();
  }

  res.json(cache.dashboard);
});


// ===============================
// 📋 CHECKLIST (NOVO)
// ===============================
app.get('/checklist/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const parent = await axios.get(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    const fields = parent.data.fields || {};

    const titulo = fields["System.Title"];
    const responsavel = fields["System.AssignedTo"]?.displayName || "Sem responsável";
    const status = fields["System.State"];

    const relations = parent.data.relations || [];

    const children = relations.filter(r =>
      r.rel === 'System.LinkTypes.Hierarchy-Forward'
    );

    const ids = children.map(c => c.url.split('/').pop());

    let checklist = [];

    if (ids.length > 0) {
      const chunkSize = 50;
      let allChildren = [];

      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);

        const resp = await axios.get(
          `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
          {
            headers: { Authorization: `Basic ${auth}` }
          }
        );

        allChildren = allChildren.concat(resp.data.value);
      }

      checklist = allChildren.map(item => ({
        id: item.id,
        titulo: item.fields["System.Title"],
        status: item.fields["System.State"]
      }));
    }

    const total = checklist.length;
    const concluidos = checklist.filter(i => i.status === "Done").length;
    const progresso = total > 0 ? Math.round((concluidos / total) * 100) : 0;

    res.json({
      id,
      titulo,
      responsavel,
      status,
      progresso,
      total,
      concluidos,
      checklist
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao montar checklist' });
  }
});


// ===============================
// 🔄 MANUAL SYNC
// ===============================
app.post('/sync', async (req, res) => {
  await syncDashboard();
  res.json({ message: "Sync executado com sucesso" });
});


// ===============================
// 🚀 START
// ===============================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);

  syncDashboard();
});
