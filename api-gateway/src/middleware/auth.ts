import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'ton_secret_super_securise'

export const authMiddleware = (
  req: Request, res: Response, next: NextFunction
) => {
  const token = req.headers.authorization?.split(' ')[1]
  
  if (!token) {
    return res.status(401).json({ error: 'Token manquant' })
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    ;(req as any).user = decoded
    next()
  } catch (err: any) {
  console.error('Erreur JWT:', err.name, '-', err.message)
  res.status(401).json({ error: 'Token invalide' })
}
}
