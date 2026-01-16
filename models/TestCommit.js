const mongoose = require('mongoose');

const TrashTestSchema = new mongoose.Schema({
    
    weapon: String,
    owner: String,

});

module.exports = mongoose.model('trash_tests', TrashTestSchema);