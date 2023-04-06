const express = require('express')
const crypto = require('crypto')
const ms = require('ms')

const app = express()
const axios = require('axios').default
const config = require('./config.js');
const request = require('request');

app.use(express.urlencoded({ extended: true }))
app.use(express.json({
    verify: (req, res, buf) => req.rawBody = buf
}))

app.get('/webhooks', (req, res) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (!mode || !token) res.sendStatus(404);
    switch (mode) {
        case 'subscribe':
            if (config.verifyToken === token) {
                console.log(`Webhooks Verified.`)
                res.status(200).send(challenge)
            } else {
                res.sendStatus(403)
            }
            break
        default:
            res.sendStatus(404)
    }
})

async function sendMessage(data) {
    const obj = {
        recipient: {
            id: data.psid
        },
        messaging_type: 'RESPONSE',
        message: {}
    }

    if (data.image) {
        obj.message.attachment = {
            type: 'image',
            payload: {
                url: data.image,
                is_reusable: true
            }
        }
    }

    if (data.content) obj.message.text = data.content

    return axios({
        url: `${config.baseURL}/me/messages`,
        method: 'post',
        params: {
            access_token: config.pageToken
        },
        data: obj,
        headers: {
            'Content-Type': 'application/json'
        }
    })
}

async function handlers(event) {
    const msg = event.entry[0].messaging[0]
    if (config.ratelimit.has(msg.sender.id)) {
        return sendMessage({
            psid: msg.sender.id,
            content: 'Bot đang xử lý câu hỏi trước, vui lòng chờ.'
        })
    }

    config.ratelimit.set(msg.sender.id, true)

    const content = msg.message.text.trim()
    switch(config.mode) {
        case'CHAT':
            const history = config.cache.get(msg.sender.id)
          return request({
            "uri": "https://api.openai.com/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.token}`
            },
            "method": "POST",
            "json": {
                model: config.openai.model,
                messages: !history ? [
                    { role: 'user', content: content },
                ] : [
                    { role: 'user', content: history.question },
                    { role: 'assistant', content: history.answer },
                    { role: 'user', content: content }
                ],
                max_tokens: config.openai.max_tokens
            }
        }, async (err, res, body) => {
            if (err) throw err
            if (!body.error) {
                const success = body.choices[0].message.content
                config.cache.del(msg.sender.id)
                config.cache.set(msg.sender.id, {
                    question: content,
                    answer: success
                }, ms('10m'))
                config.ratelimit.delete(msg.sender.id)
                await sendMessage({ psid: msg.sender.id, content: success })
            } else {
                config.ratelimit.delete(msg.sender.id);
                return sendMessage({ psid: msg.sender.id, content: body.error.message })
            }
        });
            // return axios({
            //     url: `https://api.openai.com/v1/chat/completions`,
            //     method: 'post',
            //     data: {
            //         model: config.openai.model,
            //         messages: !history ?
            //             [
            //                 {
            //                     role: 'user',
            //                     content: content
            //                 },
            //             ] : [
            //                 {
            //                     role: 'user',
            //                     content: history.question
            //                 },
            //                 {
            //                     role: 'assistant',
            //                     content: history.answer
            //                 },
            //                 {
            //                     role: 'user',
            //                     content: content
            //                 }
            //             ],
            //         max_tokens: config.openai.max_tokens
            //     },
            //     headers: {
            //         "Content-Type": "application/json",
            //         "Authorization": `Bearer ${process.env.token}`
            //     }
            // }).then(res => {
            //     const success = res.data.choices[0].message.content
        
            //     config.cache.del(msg.sender.id)
            //     config.cache.set(msg.sender.id, {
            //         question: content,
            //         answer: success
            //     }, ms('10m'))
        
            //     config.ratelimit.delete(msg.sender.id)
            //     return sendMessage({
            //         psid: msg.sender.id,
            //         content: success
            //     })
            // }).catch(error => {
            //     console.error(error)
            //     config.ratelimit.delete(msg.sender.id)
        
            //     return sendMessage({
            //         psid: msg.sender.id,
            //         content: 'Có lỗi xảy ra, xin hãy kiểm tra lại.'
            //     })
            // })
        case'IMAGE':
            return axios({
                url: 'https://api.openai.com/v1/images/generations',
                method: 'post',
                data: {
                    n: 1,
                    prompt: content,
                    response_format: 'url',
                    size: '1024x1024'
                },
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.token}`
                }
            }).then(res => {
              console.log(res.body)
                config.ratelimit.delete(msg.sender.id)
                return sendMessage({
                    psid: msg.sender.id,
                    image: res.data.data[0].url
                })
            }).catch(error => {
                // console.error(error)
                config.ratelimit.delete(msg.sender.id)
        
                return sendMessage({
                    psid: msg.sender.id,
                    content: 'Có lỗi xảy ra, xin hãy kiểm tra lại.'
                })
            })
        default: throw new Error()
    }
}

app.post('/webhooks', (req, res) => {
    if (config.appSecret) {
        const signature = req.headers['x-hub-signature-256']
        if (!signature) return res.sendStatus(401)

        const signatureHash = signature.split('=')[1]
        const expectedHash = crypto.createHmac('sha256', config.appSecret).update(req.rawBody).digest('hex')

        if (signatureHash !== expectedHash) return res.sendStatus(403)
    }

    handlers.call(null, req.body)
    return res.sendStatus(200)
})

app.listen(config.port, () => console.log(`App đang chạy tại port: ${config.port}`))
