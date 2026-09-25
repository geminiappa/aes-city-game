const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized:false }
        : false
});


app.use(express.json({limit:'5mb'}));

app.use(express.static(path.join(__dirname,'public')));



async function initDB(){

try{

await pool.query(`

CREATE TABLE IF NOT EXISTS user_saves(

user_id VARCHAR(255) PRIMARY KEY,

save_data JSONB NOT NULL,

updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

`);



await pool.query(`

CREATE TABLE IF NOT EXISTS leaderboard(

user_id VARCHAR(255) PRIMARY KEY,

username VARCHAR(255),

rebirths BIGINT DEFAULT 0,

energy BIGINT DEFAULT 0,

money BIGINT DEFAULT 0,

city_level INT DEFAULT 0,

updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

`);



console.log("Database ready");


}catch(e){

console.error(e);

}

}


initDB();




// ================= SAVE =================


app.post('/api/save',async(req,res)=>{


const {userId,saveData}=req.body;


if(!userId || !saveData){

return res.status(400).json({

success:false,

error:"missing data"

});

}



try{


await pool.query(`

INSERT INTO user_saves

(user_id,save_data)

VALUES($1,$2)


ON CONFLICT(user_id)

DO UPDATE SET

save_data=$2,

updated_at=CURRENT_TIMESTAMP

`,
[
userId,
saveData
]);





// рейтинг

await pool.query(`

INSERT INTO leaderboard

(
user_id,
username,
rebirths,
energy,
money,
city_level
)

VALUES($1,$2,$3,$4,$5,$6)


ON CONFLICT(user_id)

DO UPDATE SET

username=$2,

rebirths=$3,

energy=$4,

money=$5,

city_level=$6,

updated_at=CURRENT_TIMESTAMP

`,
[

userId,

saveData.profile?.name || "Оператор",

saveData.rebirths || 0,

Math.floor(saveData.energy || 0),

Math.floor(saveData.money || 0),

saveData.cityLevel || 0

]);





res.json({

success:true

});


}catch(e){

console.error(e);

res.status(500).json({

success:false

});

}


});






// ================= LOAD =================


app.get('/api/save/:id',async(req,res)=>{


try{


const result=await pool.query(

"SELECT save_data FROM user_saves WHERE user_id=$1",

[req.params.id]

);



if(result.rows.length){

res.json({

success:true,

data:result.rows[0].save_data

});

}else{


res.json({

success:true,

data:null

});


}



}catch(e){

res.status(500).json({

success:false

});

}



});






// ================= LEADERBOARD =================



app.get('/api/leaderboard/:type',async(req,res)=>{


let sort="rebirths";


if(req.params.type==="energy")
sort="energy";


if(req.params.type==="money")
sort="money";


if(req.params.type==="city")
sort="city_level";



try{


const result=await pool.query(`

SELECT

username,

rebirths,

energy,

money,

city_level

FROM leaderboard

ORDER BY ${sort} DESC

LIMIT 50

`);



res.json({

success:true,

data:result.rows

});



}catch(e){


res.status(500).json({

success:false

});


}


});






// ================= PLAYER POSITION =================


app.get('/api/player/:id',async(req,res)=>{


try{


const result=await pool.query(`

SELECT *

FROM leaderboard

WHERE user_id=$1

`,
[
req.params.id
]);



res.json({

success:true,

data:result.rows[0] || null

});



}catch(e){


res.status(500).json({

success:false

});


}



});







app.listen(PORT,()=>{

console.log(
`Server started ${PORT}`
);

});
