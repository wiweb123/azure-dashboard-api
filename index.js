require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = 3000;

// 🔐 Azure config
const ORG = process.env.AZURE_ORG;
const PROJECT = process.env.AZURE_PROJECT;
const PAT = process.env.AZURE_PAT;

const auth = Buffer.from(`:${PAT}`).toString('base64');


// ===============================
// 🧠 HELPERS (CHECKLIST + STATE)
// ===============================
function calculateProgress(checklist) {
  const total = checklist.length;
  const done = checklist.filter(i => i.status === "Done").length;

  return total === 0 ? 0 : done / total;
}

function getStateByChecklist(progress) {
  if (progress === 1) return "Done";
  if (progress === 0) return "New";
  return "Active";
}

async function updateAzureWorkItem(workItemId, patch) {
  return axios.patch(
    `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${workItemId}?api-version=7.0`,
    patch,
    {
      headers: {
        "Content-Type": "application/json-patch+json",
        Authorization: `Basic ${auth}`
      }
    }
  );
}


// ===============================
// 🟢 HEALTH CHECK
// ===============================
app.get('/', (req, res) => {
  res.send('API funcionando 🚀');
});


// ===============================
// 🔎 BUSCAR TASK
// ===============================
app.get('/task/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const response = await axios.get(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${id}?api-version=7.0`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao buscar task' });
  }
});


// ===============================
// 🔎 BUSCAR FILHOS (CHECKLIST)
// ===============================
app.get('/task/:id/children', async (req, res) => {
  const { id } = req.params;

  try {
    const response = await axios.get(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    const relations = response.data.relations || [];

    const children = relations.filter(r =>
      r.rel === 'System.LinkTypes.Hierarchy-Forward'
    );

    const ids = children.map(c => c.url.split('/').pop());

    if (ids.length === 0) return res.json([]);

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

    res.json(allChildren);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao buscar filhos' });
  }
});


// ===============================
// 📊 CHECKLIST + PROGRESSO
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

    const fields = parent.data.fields;

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
// 🔁 UPDATE CHECKLIST + MOVE CARD
// ===============================
app.post('/checklist/update-state', async (req, res) => {
  const { workItemId, checklist } = req.body;

  try {
    const progress = calculateProgress(checklist);
    const newState = getStateByChecklist(progress);

    const patch = [
      {
        op: "add",
        path: "/fields/System.State",
        value: newState
      },
      {
        op: "add",
        path: "/fields/Custom.ChecklistProgress",
        value: Math.round(progress * 100)
      }
    ];

    await updateAzureWorkItem(workItemId, patch);

    res.json({
      success: true,
      workItemId,
      progress: Math.round(progress * 100),
      newState
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao atualizar checklist' });
  }
});


// ===============================
// 📦 CARDS
// ===============================
app.get('/cards', async (req, res) => {
  try {
    const query = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE 
          [System.TeamProject] = '${PROJECT}'
          AND [System.State] <> 'Done'
          AND [System.State] <> 'Canceled'
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

    const chunkSize = 50;
    let allCards = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);

      const resp = await axios.get(
        `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      allCards = allCards.concat(resp.data.value);
    }

    const cards = allCards.map(item => ({
      id: item.id,
      titulo: item.fields["System.Title"],
      status: item.fields["System.State"],
      responsavel: item.fields["System.AssignedTo"]?.displayName || "Sem responsável"
    }));

    res.json(cards);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao buscar cards' });
  }
});


// ===============================
// 📊 KANBAN
// ===============================
app.get('/kanban', async (req, res) => {
  try {

    const filtroResponsavel = req.query.responsavel;

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

    const chunkSize = 50;
    let allCards = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);

      const resp = await axios.get(
        `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      allCards = allCards.concat(resp.data.value);
    }

    const kanban = {
      "Fila Seller": [],
      "Fila Analista": [],
      "Em Andamento": [],
      "Em Impedimento": [],
      "Concluído": []
    };

    allCards.forEach(item => {
      const nome = item.fields["System.AssignedTo"]?.displayName || "Sem responsável";

      if (
        filtroResponsavel &&
        !nome.toLowerCase().includes(filtroResponsavel.toLowerCase())
      ) return;

      const status = item.fields["System.State"];

      const card = {
        id: item.id,
        titulo: item.fields["System.Title"],
        responsavel: nome
      };

      if (status === "New") kanban["Fila Seller"].push(card);
      else if (status === "Approved" || status === "Ready") kanban["Fila Analista"].push(card);
      else if (status === "Active") kanban["Em Andamento"].push(card);
      else if (status === "Blocked") kanban["Em Impedimento"].push(card);
      else kanban["Concluído"].push(card);
    });

    res.json(kanban);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao montar kanban' });
  }
});


// ===============================
// 👥 USUÁRIOS
// ===============================
app.get('/usuarios', async (req, res) => {
  try {

    const query = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE 
          [System.TeamProject] = '${PROJECT}'
          AND [System.ChangedDate] >= @StartOfDay('-30')
      `
    };

    const wiqlResponse = await axios.post(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/wiql?api-version=7.0`,
      query,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const ids = wiqlResponse.data.workItems.map(w => w.id);

    const chunkSize = 50;
    let allCards = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);

      const resp = await axios.get(
        `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      allCards = allCards.concat(resp.data.value);
    }

    const usuariosMap = {};

    allCards.forEach(item => {
      const user = item.fields["System.AssignedTo"];
      if (user && user.displayName) {
        usuariosMap[user.displayName] = true;
      }
    });

    res.json(Object.keys(usuariosMap).sort());

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});


// ===============================
// 🚀 START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

app.get('/dashboard', async (req, res) => {
  try {
    // ===============================
    // 1. BUSCA IDS (WIQL - 1 chamada)
    // ===============================
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
      return res.json({
        kpis: {},
        kanban: {},
        users: []
      });
    }

    // ===============================
    // 2. BUSCA WORK ITEMS (BATCH)
    // ===============================
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
    // 3. KPIs
    // ===============================
    const total = allItems.length;
    const done = allItems.filter(i => i.fields["System.State"] === "Done").length;
    const active = allItems.filter(i => i.fields["System.State"] === "Active").length;
    const blocked = allItems.filter(i => i.fields["System.State"] === "Blocked").length;

    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    // ===============================
    // 4. KANBAN
    // ===============================
    const kanban = {
      "Fila Seller": [],
      "Fila Analista": [],
      "Em Andamento": [],
      "Em Impedimento": [],
      "Concluído": []
    };

    // ===============================
    // 5. PRODUTIVIDADE POR USUÁRIO
    // ===============================
    const users = {};

    allItems.forEach(item => {
      const fields = item.fields;

      const status = fields["System.State"];
      const title = fields["System.Title"];
      const user = fields["System.AssignedTo"]?.displayName || "Sem responsável";

      // Kanban mapping (igual seu sistema atual)
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

      // users metrics
      if (!users[user]) {
        users[user] = {
          nome: user,
          total: 0,
          done: 0,
          active: 0
        };
      }

      users[user].total += 1;

      if (status === "Done") users[user].done += 1;
      if (status === "Active") users[user].active += 1;
    });

    // transforma users em array
    const usersArray = Object.values(users).map(u => ({
      ...u,
      taxaConclusao: u.total > 0 ? Math.round((u.done / u.total) * 100) : 0
    }));

    // ===============================
    // 6. RESPONSE FINAL
    // ===============================
    res.json({
      kpis: {
        total,
        done,
        active,
        blocked,
        progress
      },
      kanban,
      users: usersArray
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao montar dashboard' });
  }
});